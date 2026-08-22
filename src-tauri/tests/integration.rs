//! Integration tests against real MySQL / PostgreSQL.
//!
//! Gated by env vars — skipped (pass) when unset:
//!   LOTDB_TEST_MYSQL_URL=mysql://user:pass@127.0.0.1:3306
//!   LOTDB_TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/db
//!
//! Locally point these at any running containers; CI provides them as
//! service containers. Everything runs through the same state-free impl
//! functions the Tauri commands call (`run_query`, `get_table_data_impl`,
//! `execute_statements_impl`, `cancel_query_impl`).

use lotdb_lib::commands::data::{execute_statements_impl, get_table_data_impl, ColumnFilter};
use lotdb_lib::commands::query::{cancel_query_impl, run_query, QueryRegistry};
use lotdb_lib::db::pool::PoolManager;
use lotdb_lib::models::connection::{ConnectionConfig, DbType};

/// Minimal `scheme://user:pass@host:port/db` parser for test URLs.
fn parse_url(url: &str) -> Option<(String, u16, String, String, Option<String>)> {
    // -> (host, port, user, password, database)
    let rest = url
        .strip_prefix("mysql://")
        .or_else(|| url.strip_prefix("postgres://"))?;
    let (auth, host_part) = rest.split_once('@')?;
    let (user, password) = auth.split_once(':')?;
    let (host, tail) = host_part.split_once(':')?;
    let (port, db) = tail.split_once('/')?;
    Some((
        host.to_string(),
        port.parse().ok()?,
        user.to_string(),
        password.to_string(),
        Some(db.to_string()),
    ))
}

fn mysql_config() -> Option<ConnectionConfig> {
    let url = std::env::var("LOTDB_TEST_MYSQL_URL").ok()?;
    let (host, port, user, password, _) = parse_url(&url)?;
    Some(ConnectionConfig {
        id: "it-mysql".into(),
        name: "it-mysql".into(),
        db_type: DbType::MySQL,
        host,
        port,
        user,
        password,
        database: None,
        readonly: false,
        group_id: None,
        ssh: None,
        ssl: None,
        color: None,
    })
}

fn pg_config() -> Option<ConnectionConfig> {
    let url = std::env::var("LOTDB_TEST_PG_URL").ok()?;
    let (host, port, user, password, database) = parse_url(&url)?;
    Some(ConnectionConfig {
        id: "it-pg".into(),
        name: "it-pg".into(),
        db_type: DbType::Postgres,
        host,
        port,
        user,
        password,
        database,
        readonly: false,
        group_id: None,
        ssh: None,
        ssl: None,
        color: None,
    })
}

fn registry() -> QueryRegistry {
    QueryRegistry::default()
}

fn cell(result: &lotdb_lib::commands::query::QueryResult, row: usize, col: usize) -> String {
    result.rows[row][col].as_str().unwrap_or("?").to_string()
}

fn json_cell(result: &lotdb_lib::commands::query::QueryResult, row: usize, col: usize) -> String {
    result.rows[row][col].to_string()
}

// ─── MySQL ────────────────────────────────────────────────────────

#[tokio::test]
async fn mysql_query_pipeline() {
    let Some(mut cfg) = mysql_config() else {
        eprintln!("LOTDB_TEST_MYSQL_URL not set — skipping MySQL integration test");
        return;
    };
    let pools = std::sync::Arc::new(PoolManager::new());
    let reg = std::sync::Arc::new(registry());

    // Fresh test database.
    pools.open(&cfg).await.expect("open root");
    run_query(
        &pools,
        &reg,
        "it-mysql",
        "DROP DATABASE IF EXISTS lotdb_it",
        None,
        None,
    )
    .await
    .expect("drop db");
    run_query(
        &pools,
        &reg,
        "it-mysql",
        "CREATE DATABASE lotdb_it",
        None,
        None,
    )
    .await
    .expect("create db");
    pools.close("it-mysql").await;

    cfg.database = Some("lotdb_it".into());
    cfg.id = "it-mysql-db".into();
    pools.open(&cfg).await.expect("open lotdb_it");

    run_query(
        &pools, &reg, "it-mysql-db",
        "CREATE TABLE t_types (id INT PRIMARY KEY AUTO_INCREMENT, big_u BIGINT UNSIGNED, dec_val DECIMAL(20,2), name VARCHAR(50), data JSON, bin BLOB)",
        None, None,
    ).await.expect("create table");

    // DML affected rows (the Phase 9 fix): 1, not 0.
    let r = run_query(
        &pools, &reg, "it-mysql-db",
        "INSERT INTO t_types (big_u, dec_val, name, data, bin) VALUES (18446744073709551615, 123456789012345678.90, 'a''b', '{\"k\": 1}', 0xdeadbeef)",
        None, None,
    ).await.expect("insert");
    assert_eq!(r.affected_rows, 1, "DML must report rows_affected");

    // Value conversion precision.
    let r = run_query(
        &pools,
        &reg,
        "it-mysql-db",
        "SELECT big_u, dec_val, name, data, bin FROM t_types WHERE id = 1",
        None,
        None,
    )
    .await
    .expect("select types");
    assert_eq!(
        cell(&r, 0, 0),
        "18446744073709551615",
        "BIGINT UNSIGNED stays exact string"
    );
    assert_eq!(
        cell(&r, 0, 1),
        "123456789012345678.90",
        "DECIMAL keeps exact text"
    );
    assert_eq!(cell(&r, 0, 2), "a'b");
    assert_eq!(
        json_cell(&r, 0, 3),
        "\"{\\\"k\\\":1}\"",
        "JSON renders as compact string"
    );
    assert_eq!(cell(&r, 0, 4), "\\xdeadbeef", "BLOB hex");

    // UPDATE affecting a counted number of rows.
    for i in 2..=3 {
        run_query(
            &pools,
            &reg,
            "it-mysql-db",
            &format!("INSERT INTO t_types (name) VALUES ('row{i}')"),
            None,
            None,
        )
        .await
        .unwrap();
    }
    let r = run_query(
        &pools,
        &reg,
        "it-mysql-db",
        "UPDATE t_types SET name = 'x' WHERE id IN (2, 3)",
        None,
        None,
    )
    .await
    .expect("update");
    assert_eq!(r.affected_rows, 2);

    // Row cap + truncated flag.
    run_query(
        &pools,
        &reg,
        "it-mysql-db",
        "CREATE TABLE t_many (n INT PRIMARY KEY)",
        None,
        None,
    )
    .await
    .unwrap();
    run_query(
        &pools, &reg, "it-mysql-db",
        "INSERT INTO t_many (n) WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 1000) SELECT n FROM seq",
        None, None,
    ).await.expect("seed t_many");
    let r = run_query(
        &pools,
        &reg,
        "it-mysql-db",
        "SELECT n FROM t_many",
        Some(100),
        None,
    )
    .await
    .expect("capped select");
    assert_eq!(r.rows.len(), 100);
    assert!(r.truncated, "must report truncation");

    // Filters use bind params — quotes and wildcards are data, not SQL.
    run_query(
        &pools,
        &reg,
        "it-mysql-db",
        "INSERT INTO t_types (name) VALUES ('50%_off'), ('500off'), (NULL)",
        None,
        None,
    )
    .await
    .unwrap();
    let res = get_table_data_impl(
        &pools,
        "it-mysql-db",
        "lotdb_it",
        None,
        "t_types",
        50,
        0,
        Some("id"),
        Some("ASC"),
        &[ColumnFilter {
            column: "name".into(),
            op: "LIKE".into(),
            value: "50%_".into(),
        }],
    )
    .await
    .expect("filtered fetch");
    // Only the literal "50%_off" matches; "500off" must not.
    let matched: Vec<String> = res
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>()
                .join(",")
        })
        .filter(|s| s.contains("50"))
        .collect();
    assert!(
        matched.iter().any(|s| s.contains("50%_off")),
        "literal match present: {matched:?}"
    );
    assert!(
        !matched.iter().any(|s| s.contains("500off")),
        "wildcard must be escaped: {matched:?}"
    );

    // Quote filter value is bound, never injected.
    let res = get_table_data_impl(
        &pools,
        "it-mysql-db",
        "lotdb_it",
        None,
        "t_types",
        50,
        0,
        None,
        None,
        &[ColumnFilter {
            column: "name".into(),
            op: "=".into(),
            value: "a'b OR '1'='1".into(),
        }],
    )
    .await
    .expect("quote filter");
    assert_eq!(res.total_count, 0, "injection payload must match nothing");

    // execute_statements: batch DML in one tx.
    let n = execute_statements_impl(
        &pools,
        "it-mysql-db",
        Some("lotdb_it"),
        &[
            "INSERT INTO t_many (n) VALUES (5000)".into(),
            "UPDATE t_many SET n = 5001 WHERE n = 5000".into(),
        ],
    )
    .await
    .expect("batch dml");
    assert_eq!(n, 2);

    // Cancellation: KILL QUERY interrupts SLEEP. The cancel task shares
    // the same manager/registry so it can find the running query.
    {
        let pools = std::sync::Arc::clone(&pools);
        let reg = std::sync::Arc::clone(&reg);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let _ = cancel_query_impl(&pools, &reg, "cancel-me").await;
        });
    }
    let r = run_query(
        &pools,
        &reg,
        "it-mysql-db",
        "SELECT SLEEP(5)",
        None,
        Some("cancel-me"),
    )
    .await;
    assert!(r.is_err(), "cancelled query must fail, got {r:?}");

    // Read-only: DML rejected, SELECT passes.
    pools.close("it-mysql-db").await;
    let mut ro_cfg = cfg.clone();
    ro_cfg.readonly = true;
    pools.open(&ro_cfg).await.expect("reopen readonly");
    let err = run_query(
        &pools,
        &reg,
        "it-mysql-db",
        "INSERT INTO t_many (n) VALUES (6000)",
        None,
        None,
    )
    .await
    .expect_err("readonly must block INSERT");
    assert!(err.message.contains("只读"), "unexpected error: {err:?}");
    run_query(
        &pools,
        &reg,
        "it-mysql-db",
        "SELECT COUNT(*) FROM t_many",
        None,
        None,
    )
    .await
    .expect("readonly still allows SELECT");
    let err = execute_statements_impl(&pools, "it-mysql-db", None, &["DELETE FROM t_many".into()])
        .await
        .expect_err("readonly must block batch DML");
    assert!(err.message.contains("只读"));

    // Cleanup.
    pools.close("it-mysql-db").await;
    cfg.readonly = false;
    cfg.database = None;
    pools.open(&cfg).await.unwrap();
    run_query(
        &pools,
        &reg,
        "it-mysql",
        "DROP DATABASE lotdb_it",
        None,
        None,
    )
    .await
    .ok();
}

// ─── PostgreSQL ───────────────────────────────────────────────────

#[tokio::test]
async fn pg_query_pipeline() {
    let Some(cfg) = pg_config() else {
        eprintln!("LOTDB_TEST_PG_URL not set — skipping PG integration test");
        return;
    };
    let pools = std::sync::Arc::new(PoolManager::new());
    let reg = std::sync::Arc::new(registry());

    pools.open(&cfg).await.expect("open pg");
    let conn_id = "it-pg";

    // Fresh schema in the connected database.
    run_query(
        &pools,
        &reg,
        conn_id,
        "DROP SCHEMA IF EXISTS lotdb_it CASCADE",
        None,
        None,
    )
    .await
    .expect("drop schema");
    run_query(&pools, &reg, conn_id, "CREATE SCHEMA lotdb_it", None, None)
        .await
        .expect("create schema");

    run_query(
        &pools, &reg, conn_id,
        "CREATE TABLE lotdb_it.t_types (id SERIAL PRIMARY KEY, uid UUID, doc JSONB, num NUMERIC(20,2), tags TEXT[], n INT, bin BYTEA)",
        None, None,
    ).await.expect("create table");

    let r = run_query(
        &pools, &reg, conn_id,
        "INSERT INTO lotdb_it.t_types (uid, doc, num, tags, n, bin) VALUES ('01928374-5a6b-7c8d-9e0f-1a2b3c4d5e6f', '{\"a\": [1, 2]}', 123456789012345678.90, ARRAY['a b','c,d'], 1, E'\\\\xDEADBEEF')",
        None, None,
    ).await.expect("insert");
    assert_eq!(r.affected_rows, 1);

    run_query(
        &pools, &reg, conn_id,
        "INSERT INTO lotdb_it.t_types (uid, doc, num, tags, n, bin) VALUES (gen_random_uuid(), '2', 2.50, ARRAY['x'], 5, NULL)",
        None, None,
    ).await.unwrap();

    // Value conversion.
    let r = run_query(
        &pools,
        &reg,
        conn_id,
        "SELECT uid, doc, num, tags, n, bin FROM lotdb_it.t_types WHERE n = 1",
        None,
        None,
    )
    .await
    .expect("select types");
    assert_eq!(
        cell(&r, 0, 0),
        "01928374-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
        "UUID as string"
    );
    assert_eq!(
        json_cell(&r, 0, 1),
        "\"{\\\"a\\\":[1,2]}\"",
        "JSONB as compact string"
    );
    assert_eq!(
        cell(&r, 0, 3),
        "{\"a b\",\"c,d\"}",
        "text[] literal with quoting"
    );
    assert_eq!(cell(&r, 0, 5), "\\xdeadbeef", "bytea hex");
    let num_str = cell(&r, 0, 2);
    assert!(
        num_str.starts_with("123456789012345678"),
        "NUMERIC must not lose precision, got {num_str}"
    );

    // Row cap.
    let r = run_query(
        &pools,
        &reg,
        conn_id,
        "SELECT n FROM generate_series(1, 300) AS n",
        Some(50),
        None,
    )
    .await
    .expect("capped");
    assert_eq!(r.rows.len(), 50);
    assert!(r.truncated);

    // Filter on an INT column — exercises the $n::int4 cast (text binds
    // would fail with "operator does not exist: integer > text").
    let res = get_table_data_impl(
        &pools,
        conn_id,
        &cfg.database.clone().unwrap(),
        Some("lotdb_it"),
        "t_types",
        50,
        0,
        None,
        None,
        &[ColumnFilter {
            column: "n".into(),
            op: ">=".into(),
            value: "5".into(),
        }],
    )
    .await
    .expect("int filter");
    assert_eq!(res.total_count, 1);

    // LIKE escaping on text[]-ish columns would error; use jsonb doc = cast instead.
    let res = get_table_data_impl(
        &pools,
        conn_id,
        &cfg.database.clone().unwrap(),
        Some("lotdb_it"),
        "t_types",
        50,
        0,
        None,
        None,
        &[ColumnFilter {
            column: "num".into(),
            op: "=".into(),
            value: "2.50".into(),
        }],
    )
    .await
    .expect("numeric filter");
    assert_eq!(res.total_count, 1, "numeric column filter via cast");

    // execute_statements through a PG sub-pool.
    let n = execute_statements_impl(
        &pools,
        conn_id,
        cfg.database.as_deref(),
        &["UPDATE lotdb_it.t_types SET n = 9 WHERE n = 5".into()],
    )
    .await
    .expect("batch dml");
    assert_eq!(n, 1);

    // Cancellation via pg_cancel_backend — same manager/registry.
    {
        let pools2 = std::sync::Arc::clone(&pools);
        let reg2 = std::sync::Arc::clone(&reg);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            let _ = cancel_query_impl(&pools2, &reg2, "pg-cancel").await;
        });
    }
    let r = run_query(
        &pools,
        &reg,
        conn_id,
        "SELECT pg_sleep(5)",
        None,
        Some("pg-cancel"),
    )
    .await;
    assert!(r.is_err(), "cancelled PG query must fail, got {r:?}");

    // Read-only.
    let mut ro_cfg = cfg.clone();
    ro_cfg.readonly = true;
    pools.close(conn_id).await;
    pools.open(&ro_cfg).await.unwrap();
    let err = run_query(
        &pools,
        &reg,
        conn_id,
        "DELETE FROM lotdb_it.t_types",
        None,
        None,
    )
    .await
    .expect_err("readonly must block DELETE");
    assert!(err.message.contains("只读"));
    run_query(&pools, &reg, conn_id, "SELECT 1", None, None)
        .await
        .expect("readonly allows SELECT");

    // Cleanup.
    pools.close(conn_id).await;
    pools.open(&cfg).await.unwrap();
    run_query(
        &pools,
        &reg,
        conn_id,
        "DROP SCHEMA lotdb_it CASCADE",
        None,
        None,
    )
    .await
    .ok();
}
