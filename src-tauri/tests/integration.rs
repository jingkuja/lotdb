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

// Regression coverage for the local-desktop data-integrity review.
#[tokio::test]
async fn mysql_review_regressions() {
    let Some(mut cfg) = mysql_config() else {
        return;
    };
    cfg.id = "review-mysql".into();
    let pools = PoolManager::new();
    let reg = QueryRegistry::default();
    pools.open(&cfg).await.unwrap();
    run_query(
        &pools,
        &reg,
        &cfg.id,
        "CREATE DATABASE IF NOT EXISTS lotdb_review_regression",
        None,
        None,
    )
    .await
    .unwrap();
    pools.close(&cfg.id).await;
    cfg.database = Some("lotdb_review_regression".into());
    review_regressions(cfg, true).await;
}

#[tokio::test]
async fn pg_review_regressions() {
    let Some(mut cfg) = pg_config() else {
        return;
    };
    cfg.id = "review-pg".into();
    review_regressions(cfg, false).await;
}

async fn review_regressions(mut cfg: ConnectionConfig, mysql: bool) {
    use lotdb_lib::commands::query::run_session_query;
    use lotdb_lib::commands::transfer::{
        export_table_data_impl, import_table_data_impl, transfer_table_data_impl,
    };
    use lotdb_lib::utils::sql::string_literal;
    let pools = PoolManager::new();
    let reg = QueryRegistry::default();
    pools.open(&cfg).await.unwrap();
    let id = cfg.id.clone();
    let db = cfg.database.clone().unwrap();
    verify_optimizations(&pools, &reg, &id, &db, mysql).await;
    let table = "lotdb_review_values";
    let query = |sql: String| {
        let pools = &pools;
        let reg = &reg;
        let id = &id;
        async move { run_query(pools, reg, id, &sql, None, None).await.unwrap() }
    };
    query(format!("DROP TABLE IF EXISTS {table}")).await;
    let generated = if mysql {
        "BIGINT PRIMARY KEY AUTO_INCREMENT"
    } else {
        "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"
    };
    let binary = if mysql { "LONGBLOB" } else { "BYTEA" };
    query(format!("CREATE TABLE {table} (id {generated}, txt VARCHAR(1000) DEFAULT 'default', amount DECIMAL(20,2), bin {binary}, flag BOOLEAN DEFAULT TRUE)")).await;
    let empty = get_table_data_impl(&pools, &id, &db, None, table, 100, 0, None, None, &[])
        .await
        .unwrap();
    assert!(empty.rows.is_empty());
    assert_eq!(empty.columns, ["id", "txt", "amount", "bin", "flag"]);
    let default_insert = if mysql {
        format!("INSERT INTO {table} () VALUES ()")
    } else {
        format!("INSERT INTO {table} DEFAULT VALUES")
    };
    query(default_insert).await;
    assert_eq!(
        query(format!("SELECT txt FROM {table}")).await.rows[0][0],
        "default"
    );
    query(format!("DELETE FROM {table}")).await;
    let text = "你好; C:\\temp\\ it's\n-- still text";
    let hex = "00ff5c27".repeat(2048);
    let blob = if mysql {
        format!("X'{hex}'")
    } else {
        format!("decode('{hex}', 'hex')")
    };
    query(format!("INSERT INTO {table} (id,txt,amount,bin) VALUES (9007199254740993,{},123456789012345678.90,{blob}), (9007199254740994,'second',NULL,NULL)", string_literal(text, mysql))).await;
    let original = query(format!("SELECT * FROM {table} ORDER BY id"))
        .await
        .rows;
    assert_eq!(original[0][0], "9007199254740993");
    assert_eq!(original[0][1], text);
    assert_eq!(
        original[0][2]
            .as_str()
            .unwrap()
            .parse::<sqlx::types::BigDecimal>()
            .unwrap(),
        "123456789012345678.90"
            .parse::<sqlx::types::BigDecimal>()
            .unwrap()
    );
    assert_eq!(original[0][3], format!("\\x{hex}"));

    // Explicit sessions: transaction rollback and temporary objects survive
    // separate invocations, but never appear in a second tab.
    let session_query = |sql: String, tab: &'static str| {
        let pools = &pools;
        let reg = &reg;
        let id = &id;
        async move { run_session_query(pools, reg, id, &sql, &[], None, None, Some(tab)).await }
    };
    session_query("BEGIN".into(), "a").await.unwrap();
    session_query(
        format!("UPDATE {table} SET txt='changed' WHERE id=9007199254740993"),
        "a",
    )
    .await
    .unwrap();
    session_query("ROLLBACK".into(), "a").await.unwrap();
    assert_eq!(
        query(format!("SELECT txt FROM {table} WHERE id=9007199254740993"))
            .await
            .rows[0][0],
        text
    );
    session_query("CREATE TEMPORARY TABLE lotdb_temp (n INT)".into(), "a")
        .await
        .unwrap();
    session_query("INSERT INTO lotdb_temp VALUES (7)".into(), "a")
        .await
        .unwrap();
    assert_eq!(
        session_query("SELECT n FROM lotdb_temp".into(), "a")
            .await
            .unwrap()
            .rows[0][0],
        7
    );
    assert!(session_query("SELECT n FROM lotdb_temp".into(), "b")
        .await
        .is_err());
    reg.close_sessions(&id);
    assert!(session_query("SELECT n FROM lotdb_temp".into(), "a")
        .await
        .is_err());

    struct Files(std::path::PathBuf);
    impl Drop for Files {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let files = Files(std::env::temp_dir().join(format!("lotdb-review-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&files.0).unwrap();
    // SQL imports use one physical session, including transaction boundaries.
    let script_path = files.0.join("script.sql").to_string_lossy().to_string();
    std::fs::write(
        &script_path,
        format!("-- transaction script\nBEGIN; UPDATE {table} SET txt='temporary'; ROLLBACK;"),
    )
    .unwrap();
    let imported = import_table_data_impl(
        None,
        &pools,
        id.clone(),
        db.clone(),
        None,
        table.into(),
        script_path.clone(),
        "sql".into(),
        true,
        false,
        vec![],
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(imported.rows_failed, 0, "{:?}", imported.error_message);
    assert_eq!(
        query(format!("SELECT * FROM {table} ORDER BY id"))
            .await
            .rows,
        original
    );

    query("DROP FUNCTION IF EXISTS lotdb_review_mutator".into()).await;
    let routine = if mysql {
        format!("DELIMITER //\nCREATE FUNCTION lotdb_review_mutator() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE {table} SET txt='blocked'; RETURN 1; END//\nDELIMITER ;\n")
    } else {
        format!("CREATE FUNCTION lotdb_review_mutator() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN UPDATE {table} SET txt='blocked'; RETURN 1; END; $$;")
    };
    std::fs::write(&script_path, routine).unwrap();
    let imported = import_table_data_impl(
        None,
        &pools,
        id.clone(),
        db.clone(),
        None,
        table.into(),
        script_path,
        "sql".into(),
        true,
        false,
        vec![],
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        imported.rows_failed, 0,
        "routine imports: {:?}",
        imported.error_message
    );

    for (export_format, import_format) in [("sql_insert", "sql"), ("json", "json"), ("csv", "csv")]
    {
        let path = files
            .0
            .join(format!("data.{import_format}"))
            .to_string_lossy()
            .to_string();
        let exported = export_table_data_impl(
            None,
            &pools,
            id.clone(),
            db.clone(),
            None,
            table.into(),
            export_format.into(),
            vec![],
            None,
            0,
            path.clone(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(exported.rows_exported, 2);
        let imported = import_table_data_impl(
            None,
            &pools,
            id.clone(),
            db.clone(),
            None,
            table.into(),
            path.clone(),
            import_format.into(),
            true,
            true,
            vec![],
            Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            imported.rows_failed, 0,
            "{}: {:?}",
            import_format, imported.error_message
        );
        assert_eq!(
            imported.rows_imported, 2,
            "{import_format}: first row must not be lost"
        );
        assert_eq!(
            query(format!("SELECT * FROM {table} ORDER BY id"))
                .await
                .rows,
            original,
            "{import_format} must round-trip exactly"
        );
    }
    let target = "lotdb_review_copy";
    query(format!("DROP TABLE IF EXISTS {target}")).await;
    query(if mysql {
        format!("CREATE TABLE {target} LIKE {table}")
    } else {
        format!("CREATE TABLE {target} (LIKE {table} INCLUDING ALL)")
    })
    .await;
    let transferred = transfer_table_data_impl(
        None,
        &pools,
        id.clone(),
        db.clone(),
        None,
        table.into(),
        id.clone(),
        db.clone(),
        None,
        target.into(),
        vec![],
        false,
        None,
        0,
    )
    .await
    .unwrap();
    assert_eq!(
        transferred.rows_failed, 0,
        "{:?}",
        transferred.error_message
    );
    assert_eq!(transferred.rows_transferred, 2);
    assert_eq!(
        query(format!("SELECT * FROM {target} ORDER BY id"))
            .await
            .rows,
        original
    );

    // A session mode change must not corrupt generated literals.
    if mysql {
        session_query("SET sql_mode='NO_BACKSLASH_ESCAPES'".into(), "escape")
            .await
            .unwrap();
    } else {
        session_query("SET standard_conforming_strings=off".into(), "escape")
            .await
            .unwrap();
    }
    assert_eq!(
        session_query(format!("SELECT {}", string_literal(text, mysql)), "escape")
            .await
            .unwrap()
            .rows[0][0],
        text
    );

    // Readonly is enforced by both commands and the database transaction.
    reg.close_sessions(&id);
    pools.close(&id).await;
    cfg.readonly = true;
    pools.open(&cfg).await.unwrap();
    for sql in [
        format!("DELETE FROM {table}"),
        format!("WITH x AS (DELETE FROM {table} RETURNING *) SELECT * FROM x"),
        "CALL unsafe_proc()".into(),
        "SET transaction_read_only=off".into(),
    ] {
        assert!(
            run_session_query(&pools, &reg, &id, &sql, &[], None, None, Some("ro"))
                .await
                .is_err(),
            "{sql}"
        );
    }
    let error = run_session_query(
        &pools,
        &reg,
        &id,
        "SELECT lotdb_review_mutator()",
        &[],
        None,
        None,
        Some("ro"),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.to_ascii_lowercase().contains("read-only")
            || error.message.to_ascii_lowercase().contains("read only"),
        "server must block writes inside SELECT functions: {error}"
    );
    assert!(pools.ensure_writable(&id).is_err());
    let no_file = files
        .0
        .join("nonexistent.sql")
        .to_string_lossy()
        .to_string();
    let denied = import_table_data_impl(
        None,
        &pools,
        id.clone(),
        db.clone(),
        None,
        table.into(),
        no_file,
        "sql".into(),
        true,
        true,
        vec![],
        Default::default(),
    )
    .await
    .unwrap_err();
    assert!(
        denied.message.contains("只读"),
        "deny before reading or truncating"
    );
    let denied = transfer_table_data_impl(
        None,
        &pools,
        id.clone(),
        db.clone(),
        None,
        table.into(),
        id.clone(),
        db.clone(),
        None,
        target.into(),
        vec![],
        true,
        None,
        0,
    )
    .await
    .unwrap_err();
    assert!(denied.message.contains("只读"));
    assert_eq!(
        run_session_query(
            &pools,
            &reg,
            &id,
            &format!("SELECT txt FROM {table} ORDER BY id"),
            &[],
            None,
            None,
            Some("ro")
        )
        .await
        .unwrap()
        .rows[0][0],
        text
    );
    reg.close_sessions(&id);
    pools.close(&id).await;
}

async fn verify_optimizations(
    pools: &PoolManager,
    registry: &QueryRegistry,
    id: &str,
    db: &str,
    mysql: bool,
) {
    use lotdb_lib::commands::data::{
        execute_checked_statements_impl, get_table_page_impl, RowCheck,
    };
    use lotdb_lib::commands::query::run_session_query;
    use lotdb_lib::commands::transfer::transfer_table_data_impl;
    let query = |sql: String| async move {
        run_query(pools, registry, id, &sql, None, None)
            .await
            .unwrap()
    };
    let empty = query("SELECT 1 AS empty_column WHERE 1=0".into()).await;
    assert_eq!(empty.columns, ["empty_column"]);
    assert!(empty.rows.is_empty());
    if !mysql {
        for sql in ["BEGIN", "SELECT 1 / 0", "ROLLBACK", "SELECT 42"] {
            let result = run_session_query(
                pools,
                registry,
                id,
                sql,
                &[],
                None,
                None,
                Some("aborted-transaction"),
            )
            .await;
            if sql.contains("1 / 0") {
                assert!(result.is_err());
            } else {
                assert!(result.is_ok(), "{sql}: {result:?}");
            }
        }
    }
    for table in ["lotdb_opt_values", "lotdb_opt_target"] {
        query(format!("DROP TABLE IF EXISTS {table}")).await;
        query(format!(
            "CREATE TABLE {table} (id INT PRIMARY KEY, txt VARCHAR(100))"
        ))
        .await;
    }
    let values = (1..=1201)
        .map(|id| format!("({id}, 'original')"))
        .collect::<Vec<_>>()
        .join(",");
    query(format!("INSERT INTO lotdb_opt_values VALUES {values}")).await;
    if !mysql {
        let result =
            query("UPDATE lotdb_opt_values SET txt='returned' WHERE id=1 RETURNING id, txt".into())
                .await;
        assert_eq!(result.columns, ["id", "txt"]);
        assert_eq!(result.affected_rows, 1);
        assert_eq!(result.rows[0][1], "returned");
        let empty = query("DELETE FROM lotdb_opt_values WHERE id=-1 RETURNING id".into()).await;
        assert_eq!(empty.columns, ["id"]);
        assert!(empty.rows.is_empty());
    }
    let page = get_table_page_impl(
        pools,
        id,
        db,
        None,
        "lotdb_opt_values",
        3,
        0,
        None,
        None,
        &[],
        false,
        &["id".into()],
    )
    .await
    .unwrap();
    assert_eq!(page.total_count, -1);
    assert_eq!(page.rows.len(), 3);
    assert_eq!(page.rows[0][0], 1);
    let next = get_table_page_impl(
        pools,
        id,
        db,
        None,
        "lotdb_opt_values",
        3,
        0,
        Some("id"),
        None,
        &[ColumnFilter {
            column: "id".into(),
            op: ">".into(),
            value: "3".into(),
        }],
        false,
        &["id".into()],
    )
    .await
    .unwrap();
    assert_eq!(next.rows[0][0], 4);
    let original = query("SELECT id, txt FROM lotdb_opt_values WHERE id=1".into())
        .await
        .rows[0]
        .clone();
    query("UPDATE lotdb_opt_values SET txt='external' WHERE id=1".into()).await;
    let conflict = execute_checked_statements_impl(
        pools,
        id,
        Some(db),
        &["UPDATE lotdb_opt_values SET txt='lost' WHERE id=1".into()],
        &[RowCheck {
            sql: "SELECT id, txt FROM lotdb_opt_values WHERE id=1 FOR UPDATE".into(),
            original,
        }],
    )
    .await;
    assert!(conflict.unwrap_err().to_string().contains("数据已被"));
    assert_eq!(
        query("SELECT txt FROM lotdb_opt_values WHERE id=1".into())
            .await
            .rows[0][0],
        "external"
    );
    let transfer = transfer_table_data_impl(
        None,
        pools,
        id.into(),
        db.into(),
        None,
        "lotdb_opt_values".into(),
        id.into(),
        db.into(),
        None,
        "lotdb_opt_target".into(),
        vec![],
        false,
        None,
        0,
    )
    .await
    .unwrap();
    assert_eq!(transfer.rows_transferred, 1201);
    assert_eq!(transfer.rows_failed, 0);
    assert!(transfer.error_message.is_none());
    let count = get_table_data_impl(
        pools,
        id,
        db,
        None,
        "lotdb_opt_target",
        0,
        0,
        None,
        None,
        &[],
    )
    .await
    .unwrap();
    assert_eq!(count.total_count, 1201);
    let duplicate = transfer_table_data_impl(
        None,
        pools,
        id.into(),
        db.into(),
        None,
        "lotdb_opt_values".into(),
        id.into(),
        db.into(),
        None,
        "lotdb_opt_target".into(),
        vec![],
        false,
        None,
        0,
    )
    .await
    .unwrap();
    assert_eq!(duplicate.rows_transferred, 0);
    assert_eq!(duplicate.rows_failed, 500);
    assert!(duplicate.error_message.is_some());
    registry.close_sessions(id);
    for table in ["lotdb_opt_values", "lotdb_opt_target"] {
        query(format!("DROP TABLE {table}")).await;
    }
}

// ─── 2026-10-22 review P0 regressions ─────────────────────────────

/// Round-trips a grid row through JSON text the way the Tauri IPC does
/// (JavaScript turns `10.0` into `10`).
fn ipc_roundtrip(row: &[serde_json::Value]) -> Vec<serde_json::Value> {
    row.iter()
        .map(|v| match v.as_f64() {
            Some(f) if v.is_f64() && f.fract() == 0.0 && f.abs() < 9e15 => {
                serde_json::json!(f as i64)
            }
            _ => v.clone(),
        })
        .collect()
}

#[tokio::test]
async fn mysql_p0_regressions() {
    use lotdb_lib::commands::data::{
        execute_checked_statements_impl, get_table_page_impl, RowCheck,
    };
    use lotdb_lib::commands::transfer::export_table_data_impl;
    let Some(mut cfg) = mysql_config() else {
        return;
    };
    cfg.id = "p0-mysql".into();
    let pools = PoolManager::new();
    let reg = registry();
    pools.open(&cfg).await.unwrap();
    let q = |sql: &'static str| {
        let (pools, reg) = (&pools, &reg);
        async move {
            run_query(pools, reg, "p0-mysql", sql, None, None)
                .await
                .unwrap()
        }
    };
    q("DROP DATABASE IF EXISTS lotdb_p0").await;
    q("CREATE DATABASE lotdb_p0").await;
    q(
        "CREATE TABLE lotdb_p0.v (id INT PRIMARY KEY, code VARCHAR(20) COLLATE utf8mb4_bin, \
       y YEAR, ok TINYINT(1), ts TIMESTAMP NULL, zero DATETIME NULL, dur TIME, price DOUBLE, \
       raw VARBINARY(4))",
    )
    .await;
    // Zero dates need a permissive sql_mode; each run_query is its own
    // session, so pin one session for both statements.
    for sql in [
        "SET SESSION sql_mode = ''",
        "INSERT INTO lotdb_p0.v VALUES (1, 'Abc', 2024, 2, '2026-10-22 12:00:00', \
         '0000-00-00 00:00:00', '-838:59:59', 10, X'00FF0102')",
    ] {
        lotdb_lib::commands::query::run_session_query(
            &pools,
            &reg,
            "p0-mysql",
            sql,
            &[],
            None,
            None,
            Some("seed"),
        )
        .await
        .unwrap();
    }
    reg.close_sessions("p0-mysql");

    // Session behaves like the mysql CLI: server time zone, `||` means OR.
    let s = q("SELECT @@session.time_zone = @@global.time_zone, 1 || 0").await;
    // Both are BIGINT expressions, which LotDB renders as strings.
    assert_eq!(
        s.rows[0],
        vec![serde_json::json!("1"), serde_json::json!("1")]
    );

    let expected = [
        serde_json::json!(1),
        serde_json::json!("Abc"),
        serde_json::json!(2024),
        serde_json::json!(2),
        serde_json::json!("2026-10-22 12:00:00"),
        serde_json::json!("0000-00-00 00:00:00"),
        serde_json::json!("-838:59:59"),
        serde_json::json!(10.0),
        serde_json::json!("\\x00ff0102"),
    ];
    // Text protocol (SQL editor) and binary protocol (grid) agree.
    let text = q("SELECT * FROM lotdb_p0.v").await;
    assert_eq!(text.rows[0], expected);
    let page = get_table_page_impl(
        &pools,
        "p0-mysql",
        "lotdb_p0",
        None,
        "v",
        10,
        0,
        None,
        None,
        &[],
        false,
        &[],
    )
    .await
    .unwrap();
    assert_eq!(page.rows[0], expected);

    // Editing a row whose DOUBLE holds a whole number is not a false conflict.
    let changed = execute_checked_statements_impl(
        &pools,
        "p0-mysql",
        Some("lotdb_p0"),
        &["UPDATE `lotdb_p0`.`v` SET `code` = 'Abd' WHERE `id` = 1".into()],
        &[RowCheck {
            sql: "SELECT * FROM `lotdb_p0`.`v` WHERE `id` = 1 FOR UPDATE".into(),
            original: ipc_roundtrip(&page.rows[0]),
        }],
    )
    .await
    .unwrap();
    assert_eq!(changed, 1);

    // Exports carry the real values, never a placeholder.
    let path = std::env::temp_dir().join("lotdb_p0_mysql.csv");
    export_table_data_impl(
        None,
        &pools,
        "p0-mysql".into(),
        "lotdb_p0".into(),
        None,
        "v".into(),
        "csv".into(),
        vec![],
        None,
        0,
        path.to_string_lossy().into(),
        false,
    )
    .await
    .unwrap();
    let csv = std::fs::read_to_string(&path).unwrap();
    assert!(
        csv.contains("2026-10-22 12:00:00") && csv.contains("\"Abd\""),
        "{csv}"
    );
    assert!(!csv.contains("不支持的类型"), "{csv}");
    // A WHERE fragment can't smuggle in a second statement.
    let err = export_table_data_impl(
        None,
        &pools,
        "p0-mysql".into(),
        "lotdb_p0".into(),
        None,
        "v".into(),
        "csv".into(),
        vec![],
        Some("1=1; DROP TABLE lotdb_p0.v".into()),
        0,
        path.to_string_lossy().into(),
        false,
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("多条语句"), "{err}");
    let _ = std::fs::remove_file(&path);

    // Passwords with URL-reserved characters connect.
    q("DROP USER IF EXISTS 'lotdb_p0_pw'@'%'").await;
    q("CREATE USER 'lotdb_p0_pw'@'%' IDENTIFIED BY 'p#a/s?s%41@:w'").await;
    let mut special = cfg.clone();
    special.id = "p0-mysql-pw".into();
    special.user = "lotdb_p0_pw".into();
    special.password = "p#a/s?s%41@:w".into();
    pools.open(&special).await.unwrap();
    pools.close(&special.id).await;
    q("DROP USER 'lotdb_p0_pw'@'%'").await;

    q("DROP DATABASE lotdb_p0").await;
    pools.close("p0-mysql").await;
}

#[tokio::test]
async fn pg_p0_regressions() {
    use lotdb_lib::commands::data::{
        execute_checked_statements_impl, get_table_page_impl, RowCheck,
    };
    use lotdb_lib::commands::transfer::{export_table_data_impl, transfer_table_data_impl};
    let Some(mut cfg) = pg_config() else {
        return;
    };
    cfg.id = "p0-pg".into();
    let db = cfg.database.clone().unwrap();
    let pools = PoolManager::new();
    let reg = registry();
    pools.open(&cfg).await.unwrap();
    let q = |sql: &'static str| {
        let (pools, reg) = (&pools, &reg);
        async move {
            run_query(pools, reg, "p0-pg", sql, None, None)
                .await
                .unwrap()
        }
    };
    q("DROP TABLE IF EXISTS lotdb_p0_v, lotdb_p0_t").await;
    q("DROP TYPE IF EXISTS lotdb_p0_mood").await;
    q("CREATE TYPE lotdb_p0_mood AS ENUM ('happy', 'sad')").await;
    q(
        "CREATE TABLE lotdb_p0_v (id int PRIMARY KEY, m lotdb_p0_mood, ip inet, net cidr, \
       d interval, tz timetz, price float8, pt point)",
    )
    .await;
    q(
        "CREATE TABLE lotdb_p0_t (id int PRIMARY KEY, m text, ip text, net text, d text, \
       tz text, price float8, pt text)",
    )
    .await;
    q(
        "INSERT INTO lotdb_p0_v VALUES (1, 'happy', '10.0.0.1', '10.1.0.0/16', \
       '1 day 02:03:04.5', '12:00:00+08', 10, '(1,2)')",
    )
    .await;

    let text = q("SELECT * FROM lotdb_p0_v").await;
    assert_eq!(text.rows[0][1], "happy");
    assert_eq!(text.rows[0][2], "10.0.0.1");
    assert_eq!(text.rows[0][3], "10.1.0.0/16");
    assert_eq!(text.rows[0][4], "1 day 02:03:04.5");
    assert_eq!(text.rows[0][7], "(1,2)");
    let page = get_table_page_impl(
        &pools,
        "p0-pg",
        &db,
        Some("public"),
        "lotdb_p0_v",
        10,
        0,
        None,
        None,
        &[],
        false,
        &[],
    )
    .await
    .unwrap();
    for col in 1..=4 {
        assert_eq!(page.rows[0][col], text.rows[0][col], "column {col}");
    }
    assert_eq!(page.rows[0][5], "12:00:00+08:00");

    let changed = execute_checked_statements_impl(
        &pools,
        "p0-pg",
        Some(&db),
        &["UPDATE \"public\".\"lotdb_p0_v\" SET \"ip\" = '10.0.0.2' WHERE \"id\" = 1".into()],
        &[RowCheck {
            sql: "SELECT * FROM \"public\".\"lotdb_p0_v\" WHERE \"id\" = 1 FOR UPDATE".into(),
            original: ipc_roundtrip(&page.rows[0]),
        }],
    )
    .await
    .unwrap();
    assert_eq!(changed, 1);

    // Transfer and export move real values.
    let r = transfer_table_data_impl(
        None,
        &pools,
        "p0-pg".into(),
        db.clone(),
        Some("public".into()),
        "lotdb_p0_v".into(),
        "p0-pg".into(),
        db.clone(),
        Some("public".into()),
        "lotdb_p0_t".into(),
        vec![],
        false,
        None,
        0,
    )
    .await
    .unwrap();
    assert_eq!((r.rows_transferred, r.error_message), (1, None));
    let moved = q("SELECT m, ip, d, pt FROM lotdb_p0_t").await;
    assert_eq!(
        moved.rows[0],
        vec![
            serde_json::json!("happy"),
            serde_json::json!("10.0.0.2"),
            serde_json::json!("1 day 02:03:04.5"),
            serde_json::json!("(1,2)"),
        ]
    );
    let path = std::env::temp_dir().join("lotdb_p0_pg.csv");
    export_table_data_impl(
        None,
        &pools,
        "p0-pg".into(),
        db.clone(),
        Some("public".into()),
        "lotdb_p0_v".into(),
        "csv".into(),
        vec![],
        None,
        0,
        path.to_string_lossy().into(),
        false,
    )
    .await
    .unwrap();
    let csv = std::fs::read_to_string(&path).unwrap();
    assert!(
        csv.contains("\"happy\"") && !csv.contains("不支持的类型"),
        "{csv}"
    );
    let _ = std::fs::remove_file(&path);

    q("DROP TABLE lotdb_p0_v, lotdb_p0_t").await;
    q("DROP TYPE lotdb_p0_mood").await;
    pools.close("p0-pg").await;
}

// ─── P1 regressions (2026-10-22 review, section 2) ────────────────

/// Session-pinned query helper for the P1 tests.
async fn session_sql(
    pools: &PoolManager,
    reg: &QueryRegistry,
    id: &str,
    session: &str,
    sql: &str,
    max_rows: Option<u64>,
) -> Result<lotdb_lib::commands::query::QueryResult, String> {
    lotdb_lib::commands::query::run_session_query(
        pools,
        reg,
        id,
        sql,
        &[],
        max_rows,
        None,
        Some(session),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Import: batches, all-or-nothing with "empty table first", mapping
/// checked before the table is touched, bad rows isolated in append mode.
async fn p1_import(pools: &PoolManager, reg: &QueryRegistry, id: &str, db: &str, mysql: bool) {
    use lotdb_lib::commands::transfer::import_table_data_impl;
    let q = |sql: String| async move {
        session_sql(pools, reg, id, "p1-import", &sql, Some(0))
            .await
            .unwrap()
    };
    let table = if mysql {
        format!("`{db}`.lotdb_p1_imp")
    } else {
        "lotdb_p1_imp".to_string()
    };
    let count = || async {
        q(format!("SELECT COUNT(*) FROM {table}")).await.rows[0][0]
            .to_string()
            .trim_matches('"')
            .to_string()
    };
    q(format!("DROP TABLE IF EXISTS {table}")).await;
    q(format!(
        "CREATE TABLE {table} (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL)"
    ))
    .await;
    q(format!("INSERT INTO {table} VALUES (1, 'keep')")).await;

    let dir = std::env::temp_dir().join(format!("lotdb-p1-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, body: String| {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path.to_string_lossy().to_string()
    };
    let import = |path: String, truncate: bool, mapping: Vec<Option<String>>| async move {
        import_table_data_impl(
            None,
            pools,
            id.into(),
            db.into(),
            None,
            "lotdb_p1_imp".into(),
            path,
            "csv".into(),
            true,
            truncate,
            mapping,
            Default::default(),
        )
        .await
    };

    // 1200 rows go in as several multi-row batches.
    let mut big = String::from("id,name\n");
    for i in 2..=1201 {
        big.push_str(&format!("{i},n{i}\n"));
    }
    let big = write("big.csv", big);
    let r = import(big.clone(), false, vec![]).await.unwrap();
    assert_eq!((r.rows_imported, r.rows_failed), (1200, 0), "{r:?}");
    assert_eq!(count().await, "1201");

    // A wrong mapping fails before the table is emptied.
    let err = import(
        big.clone(),
        true,
        vec![Some("id".into()), Some("nope".into())],
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("nope"), "{err}");
    assert_eq!(count().await, "1201");

    // With "empty first", a failing row rolls everything back.
    let dup = write("dup.csv", "id,name\n7,a\n7,b\n".into());
    let err = import(dup, true, vec![]).await.unwrap_err();
    assert!(err.message.contains("已回滚"), "{err}");
    assert_eq!(count().await, "1201");

    // Without it, only the bad row is lost.
    let bad = write("bad.csv", "id,name\n5000,a\n5001,\n5002,c\n".into());
    let r = import(bad, false, vec![]).await.unwrap();
    assert_eq!((r.rows_imported, r.rows_failed), (2, 1), "{r:?}");
    assert!(
        r.error_message.as_deref().unwrap_or("").contains("第 2 行"),
        "{r:?}"
    );

    // And "empty first" that succeeds replaces the contents.
    let small = write("small.csv", "id,name\n1,x\n2,y\n".into());
    let r = import(small, true, vec![]).await.unwrap();
    assert_eq!(r.rows_imported, 2, "{r:?}");
    assert_eq!(count().await, "2");

    q(format!("DROP TABLE {table}")).await;
    reg.close_sessions(id);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A capped result stops the server instead of draining the rest, and the
/// session (including an open transaction) stays usable.
async fn p1_row_cap(pools: &PoolManager, reg: &QueryRegistry, id: &str, mysql: bool) {
    // Effectively endless (10^9 rows): without an early stop this never returns.
    let endless = if mysql {
        session_sql(
            pools,
            reg,
            id,
            "cap",
            "DROP TABLE IF EXISTS lotdb_p1_seq",
            None,
        )
        .await
        .unwrap();
        session_sql(
            pools,
            reg,
            id,
            "cap",
            "CREATE TABLE lotdb_p1_seq (n INT) AS WITH RECURSIVE s(n) AS \
             (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 1000) SELECT n FROM s",
            None,
        )
        .await
        .unwrap();
        "SELECT 1 FROM lotdb_p1_seq a, lotdb_p1_seq b, lotdb_p1_seq c"
    } else {
        "SELECT generate_series(1, 1000000000)"
    };
    let start = std::time::Instant::now();
    let r = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        session_sql(pools, reg, id, "cap", endless, Some(10)),
    )
    .await
    .expect("capped query must not read the whole result")
    .unwrap();
    assert!(r.truncated);
    assert_eq!(r.rows.len(), 10);
    eprintln!("capped query returned in {:?}", start.elapsed());
    let one = session_sql(pools, reg, id, "cap", "SELECT 7", None)
        .await
        .unwrap();
    assert_eq!(one.rows[0][0].to_string().trim_matches('"'), "7");

    // Result just one row over the cap: the stop must not hit the next
    // statement, which runs long enough to be killed if it did.
    let three = if mysql {
        "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3"
    } else {
        "SELECT generate_series(1, 3)"
    };
    let next = if mysql {
        "SELECT SLEEP(0.3), 5"
    } else {
        "SELECT pg_sleep(0.3)::text, 5"
    };
    for _ in 0..3 {
        let r = session_sql(pools, reg, id, "cap", three, Some(2))
            .await
            .unwrap();
        assert!(r.truncated);
        let r = session_sql(pools, reg, id, "cap", next, None)
            .await
            .unwrap();
        assert_eq!(r.rows[0][1].to_string().trim_matches('"'), "5");
    }

    // Inside a transaction: earlier work survives and COMMIT succeeds.
    let table = "lotdb_p1_cap";
    session_sql(
        pools,
        reg,
        id,
        "cap",
        &format!("DROP TABLE IF EXISTS {table}"),
        None,
    )
    .await
    .unwrap();
    session_sql(
        pools,
        reg,
        id,
        "cap",
        &format!("CREATE TABLE {table} (id INT)"),
        None,
    )
    .await
    .unwrap();
    for sql in [
        "BEGIN".to_string(),
        format!("INSERT INTO {table} VALUES (1)"),
    ] {
        session_sql(pools, reg, id, "cap", &sql, None)
            .await
            .unwrap();
    }
    let r = session_sql(pools, reg, id, "cap", endless, Some(5))
        .await
        .unwrap();
    assert_eq!(r.rows.len(), 5);
    session_sql(pools, reg, id, "cap", "COMMIT", None)
        .await
        .unwrap();
    let r = session_sql(
        pools,
        reg,
        id,
        "cap",
        &format!("SELECT COUNT(*) FROM {table}"),
        None,
    )
    .await
    .unwrap();
    assert_eq!(r.rows[0][0].to_string().trim_matches('"'), "1");
    session_sql(pools, reg, id, "cap", &format!("DROP TABLE {table}"), None)
        .await
        .unwrap();
    if mysql {
        session_sql(pools, reg, id, "cap", "DROP TABLE lotdb_p1_seq", None)
            .await
            .unwrap();
    }
    reg.close_sessions(id);
}

#[tokio::test]
async fn mysql_p1_regressions() {
    use lotdb_lib::commands::admin::{create_user_impl, list_processes_impl};
    let Some(mut cfg) = mysql_config() else {
        return;
    };
    cfg.id = "p1-mysql".into();
    let pools = PoolManager::new();
    let reg = registry();
    pools.open(&cfg).await.unwrap();
    let q = |sql: &'static str| {
        let (pools, reg) = (&pools, &reg);
        async move {
            run_query(pools, reg, "p1-mysql", sql, None, None)
                .await
                .unwrap()
        }
    };
    q("DROP DATABASE IF EXISTS lotdb_p1").await;
    q("CREATE DATABASE lotdb_p1").await;

    p1_import(&pools, &reg, "p1-mysql", "lotdb_p1", true).await;
    lotdb_lib::commands::query::configure_session_impl(
        &pools,
        &reg,
        "p1-mysql",
        "cap",
        Some("lotdb_p1"),
        None,
    )
    .await
    .unwrap();
    p1_row_cap(&pools, &reg, "p1-mysql", true).await;

    // PROCESSLIST.ID is BIGINT UNSIGNED.
    let procs = list_processes_impl(&pools, "p1-mysql".into())
        .await
        .unwrap();
    assert!(procs.iter().any(|p| p.id > 0));

    // Quotes, backslashes and `#` reach the server exactly as typed.
    let (user, password) = ("lotdb p1'u", r#"p'a\b"c#"#);
    run_query(
        &pools,
        &reg,
        "p1-mysql",
        "DROP USER IF EXISTS 'lotdb p1''u'@'%'",
        None,
        None,
    )
    .await
    .unwrap();
    create_user_impl(
        &pools,
        "p1-mysql".into(),
        user.into(),
        String::new(),
        password.into(),
    )
    .await
    .unwrap();
    let mut login = cfg.clone();
    login.id = "p1-mysql-login".into();
    login.user = user.into();
    login.password = password.into();
    pools.open(&login).await.unwrap();
    pools.close(&login.id).await;
    q("DROP USER 'lotdb p1''u'@'%'").await;

    q("DROP DATABASE lotdb_p1").await;
    pools.close("p1-mysql").await;
}

#[tokio::test]
async fn pg_p1_regressions() {
    use lotdb_lib::commands::admin::{create_user_impl, drop_database_impl, get_table_sizes_impl};
    use lotdb_lib::commands::query::configure_session_impl;
    use lotdb_lib::commands::schema::get_table_foreign_keys_impl;
    let Some(mut cfg) = pg_config() else {
        return;
    };
    cfg.id = "p1-pg".into();
    let db = cfg.database.clone().unwrap();
    let pools = PoolManager::new();
    let reg = registry();
    pools.open(&cfg).await.unwrap();
    let q = |sql: &'static str| {
        let (pools, reg) = (&pools, &reg);
        async move {
            run_query(pools, reg, "p1-pg", sql, None, None)
                .await
                .unwrap()
        }
    };

    p1_import(&pools, &reg, "p1-pg", &db, false).await;
    p1_row_cap(&pools, &reg, "p1-pg", false).await;

    // Mixed-case table names, and sizes come from the selected database.
    q("DROP TABLE IF EXISTS \"LotdbP1User\"").await;
    q("CREATE TABLE \"LotdbP1User\" (id int)").await;
    let sizes = get_table_sizes_impl(&pools, "p1-pg".into(), db.clone(), Some("public".into()))
        .await
        .unwrap();
    assert!(sizes.iter().any(|t| t.table_name == "LotdbP1User"));
    q("DROP TABLE \"LotdbP1User\"").await;

    q("DROP DATABASE IF EXISTS lotdb_p1_other").await;
    q("CREATE DATABASE lotdb_p1_other").await;
    let other = pools
        .pg_pool_for_database("p1-pg", "lotdb_p1_other")
        .await
        .unwrap();
    sqlx::query("CREATE TABLE only_here (id int)")
        .execute(&other)
        .await
        .unwrap();
    let sizes = get_table_sizes_impl(
        &pools,
        "p1-pg".into(),
        "lotdb_p1_other".into(),
        Some("public".into()),
    )
    .await
    .unwrap();
    assert_eq!(
        sizes
            .iter()
            .map(|t| t.table_name.as_str())
            .collect::<Vec<_>>(),
        ["only_here"]
    );
    // LotDB's own cached pool for that database must not block the DROP.
    drop_database_impl(&pools, "p1-pg".into(), "lotdb_p1_other".into())
        .await
        .unwrap();

    // Composite foreign keys pair columns by position.
    q("DROP TABLE IF EXISTS lotdb_p1_child, lotdb_p1_parent").await;
    q("CREATE TABLE lotdb_p1_parent (a int, b int, PRIMARY KEY (a, b))").await;
    q("CREATE TABLE lotdb_p1_child (x int, y int, \
       FOREIGN KEY (x, y) REFERENCES lotdb_p1_parent (a, b))")
    .await;
    let fks = get_table_foreign_keys_impl(
        &pools,
        "p1-pg".into(),
        db.clone(),
        Some("public".into()),
        "lotdb_p1_child".into(),
    )
    .await
    .unwrap();
    assert_eq!(fks.len(), 1);
    assert_eq!(fks[0].columns, ["x", "y"]);
    assert_eq!(fks[0].ref_columns, ["a", "b"]);
    q("DROP TABLE lotdb_p1_child, lotdb_p1_parent").await;

    // Switching schema keeps `public` on the search path.
    q("DROP SCHEMA IF EXISTS lotdb_p1_s CASCADE").await;
    q("CREATE SCHEMA lotdb_p1_s").await;
    q("CREATE OR REPLACE FUNCTION public.lotdb_p1_fn() RETURNS int LANGUAGE sql AS 'SELECT 42'")
        .await;
    configure_session_impl(&pools, &reg, "p1-pg", "sp", None, Some("lotdb_p1_s"))
        .await
        .unwrap();
    let r = session_sql(&pools, &reg, "p1-pg", "sp", "SELECT lotdb_p1_fn()", None)
        .await
        .unwrap();
    assert_eq!(r.rows[0][0], 42);
    let r = session_sql(&pools, &reg, "p1-pg", "sp", "SHOW search_path", None)
        .await
        .unwrap();
    assert!(
        r.rows[0][0].as_str().unwrap().starts_with("lotdb_p1_s"),
        "{:?}",
        r.rows
    );
    reg.close_sessions("p1-pg");
    q("DROP FUNCTION public.lotdb_p1_fn()").await;
    q("DROP SCHEMA lotdb_p1_s").await;

    // Role passwords with quotes and backslashes.
    let (user, password) = ("lotdb_p1_role", r"p'a\b");
    q("DROP ROLE IF EXISTS lotdb_p1_role").await;
    create_user_impl(
        &pools,
        "p1-pg".into(),
        user.into(),
        String::new(),
        password.into(),
    )
    .await
    .unwrap();
    let mut login = cfg.clone();
    login.id = "p1-pg-login".into();
    login.user = user.into();
    login.password = password.into();
    pools.open(&login).await.unwrap();
    pools.close(&login.id).await;
    q("DROP ROLE lotdb_p1_role").await;

    pools.close("p1-pg").await;
}

/// SSH tunnels: closing a connection frees the local port, and encrypted
/// private keys work with a passphrase. Gated by:
///   LOTDB_TEST_SSH=host:port            (SSH server)
///   LOTDB_TEST_SSH_FINGERPRINT=SHA256:… (its host key)
///   LOTDB_TEST_SSH_USER / _PASSWORD / _KEY / _PASSPHRASE
///   LOTDB_TEST_SSH_DB_HOST=host:port    (PG as seen from the SSH server)
#[tokio::test]
async fn ssh_tunnel_lifecycle() {
    use lotdb_lib::models::connection::SshConfig;
    let (Some(mut cfg), Ok(ssh)) = (pg_config(), std::env::var("LOTDB_TEST_SSH")) else {
        return;
    };
    let env = |k: &str| std::env::var(format!("LOTDB_TEST_SSH_{k}")).unwrap();
    let (ssh_host, ssh_port) = ssh.split_once(':').unwrap();
    let db_host = env("DB_HOST");
    let (db_host, db_port) = db_host.split_once(':').unwrap();
    cfg.id = "p1-ssh".into();
    cfg.host = db_host.into();
    cfg.port = db_port.parse().unwrap();
    let base = SshConfig {
        host_key_fingerprint: Some(env("FINGERPRINT")),
        host: ssh_host.into(),
        port: ssh_port.parse().unwrap(),
        user: env("USER"),
        auth_type: "password".into(),
        password: Some(env("PASSWORD")),
        private_key_path: None,
        passphrase: None,
    };
    let key = SshConfig {
        auth_type: "key".into(),
        password: None,
        private_key_path: Some(env("KEY")),
        passphrase: Some(env("PASSPHRASE")),
        ..base.clone()
    };
    let pools = PoolManager::new();
    let reg = registry();

    for ssh in [base, key.clone()] {
        cfg.ssh = Some(ssh);
        pools.open(&cfg).await.unwrap();
        let port = pools.pools.get("p1-ssh").unwrap().effective_port;
        let r = run_query(&pools, &reg, "p1-ssh", "SELECT 1", None, None)
            .await
            .unwrap();
        assert_eq!(r.rows[0][0], 1);
        reg.close_sessions("p1-ssh");
        pools.close("p1-ssh").await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err(),
            "tunnel port {port} must be closed after disconnect"
        );
    }

    // "Test connection" builds and drops a connection the same way.
    cfg.ssh = Some(key.clone());
    let conn = lotdb_lib::db::pool::build_connection_pub(&cfg)
        .await
        .unwrap();
    let port = conn.effective_port;
    conn.pool.close().await;
    drop(conn);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err());

    // An encrypted key without its passphrase says so.
    cfg.ssh = Some(SshConfig {
        passphrase: None,
        ..key
    });
    let err = pools.open(&cfg).await.unwrap_err();
    assert!(err.message.contains("口令"), "{err}");
}

// ─── P2 regressions (2026-10-22 review, section 3) ────────────────

/// Runs `test` on a single-threaded runtime in its own thread and fails if it
/// does not finish in time. A DashMap guard held across an `.await` makes a
/// concurrent close block that only thread forever.
fn finishes_on_one_thread(
    test: impl FnOnce() -> futures::future::BoxFuture<'static, ()> + Send + 'static,
) {
    let (done, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(test());
        let _ = done.send(());
    });
    wait.recv_timeout(std::time::Duration::from_secs(30))
        .expect("close blocked behind a running query");
}

/// Exported files always start with the header, even for an empty table
/// (columns come from describing the query, not from the first row).
async fn p2_empty_export_has_header(pools: &PoolManager, id: &str, db: &str) {
    use lotdb_lib::commands::transfer::export_table_data_impl;
    let path = std::env::temp_dir().join(format!("lotdb_p2_{id}.csv"));
    let done = export_table_data_impl(
        None,
        pools,
        id.into(),
        db.into(),
        None,
        "empty".into(),
        "csv".into(),
        vec![],
        None,
        0,
        path.to_string_lossy().into_owned(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(done.rows_exported, 0);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "\"id\",\"lock\"\n");
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn mysql_p2_regressions() {
    let Some(mut cfg) = mysql_config() else {
        return;
    };
    cfg.id = "p2-mysql".into();
    let pools = PoolManager::new();
    let reg = registry();
    pools.open(&cfg).await.unwrap();
    for sql in [
        "DROP DATABASE IF EXISTS lotdb_p2",
        "CREATE DATABASE lotdb_p2",
        "CREATE TABLE lotdb_p2.t (id INT PRIMARY KEY, `set` INT, `lock` VARCHAR(10))",
        "CREATE TABLE lotdb_p2.empty (id INT, `lock` INT)",
        "CREATE VIEW lotdb_p2.slow AS SELECT SLEEP(2) AS s",
    ] {
        run_query(&pools, &reg, "p2-mysql", sql, None, None)
            .await
            .unwrap();
    }
    p2_empty_export_has_header(&pools, "p2-mysql", "lotdb_p2").await;

    // Read-only mode lets metadata and keyword-named columns through.
    let mut ro = cfg.clone();
    ro.id = "p2-mysql-ro".into();
    ro.readonly = true;
    pools.open(&ro).await.unwrap();
    for sql in [
        "SHOW CREATE TABLE lotdb_p2.t",
        "SELECT `set`, `lock` FROM lotdb_p2.t WHERE `set` = 1",
        "EXPLAIN SELECT * FROM lotdb_p2.t",
    ] {
        run_query(&pools, &reg, "p2-mysql-ro", sql, None, None)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let err = run_query(&pools, &reg, "p2-mysql-ro", "SELECT 1 INTO @x", None, None)
        .await
        .unwrap_err();
    assert!(err.message.contains("只读"), "{err}");

    // Closing while a data-grid query runs must not wait on the map guard.
    finishes_on_one_thread(move || {
        Box::pin(async move {
            let pools = PoolManager::new();
            pools.open(&cfg).await.unwrap();
            let page = get_table_data_impl(
                &pools,
                "p2-mysql",
                "lotdb_p2",
                None,
                "slow",
                10,
                0,
                None,
                None,
                &[],
            );
            let close = async {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                pools.close("p2-mysql").await;
            };
            let _ = tokio::join!(page, close);
            assert!(!pools.is_open("p2-mysql"));
        })
    });
}

#[tokio::test]
async fn pg_p2_regressions() {
    let Some(mut cfg) = pg_config() else {
        return;
    };
    cfg.id = "p2-pg".into();
    let pools = PoolManager::new();
    let reg = registry();
    pools.open(&cfg).await.unwrap();
    for sql in [
        "DROP DATABASE IF EXISTS lotdb_p2 WITH (FORCE)",
        "CREATE DATABASE lotdb_p2",
    ] {
        run_query(&pools, &reg, "p2-pg", sql, None, None)
            .await
            .unwrap();
    }
    let db = pools
        .pg_pool_for_database("p2-pg", "lotdb_p2")
        .await
        .unwrap();
    for sql in [
        "CREATE TABLE t (id INT PRIMARY KEY, lock INT, reset TEXT, copy TEXT)",
        "CREATE TABLE empty (id INT, lock INT)",
        "CREATE VIEW slow AS SELECT pg_sleep(2)::text AS s",
    ] {
        sqlx::query(sql).execute(&db).await.unwrap();
    }
    p2_empty_export_has_header(&pools, "p2-pg", "lotdb_p2").await;

    let mut ro = cfg.clone();
    ro.id = "p2-pg-ro".into();
    ro.readonly = true;
    ro.database = Some("lotdb_p2".into());
    pools.open(&ro).await.unwrap();
    for sql in [
        "SELECT lock, reset, copy FROM t WHERE lock = 1",
        "TABLE t",
        "EXPLAIN (ANALYZE) SELECT * FROM t",
    ] {
        run_query(&pools, &reg, "p2-pg-ro", sql, None, None)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }
    let err = run_query(
        &pools,
        &reg,
        "p2-pg-ro",
        "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("只读"), "{err}");

    finishes_on_one_thread(move || {
        Box::pin(async move {
            let pools = PoolManager::new();
            pools.open(&cfg).await.unwrap();
            let page = get_table_data_impl(
                &pools,
                "p2-pg",
                "lotdb_p2",
                None,
                "slow",
                10,
                0,
                None,
                None,
                &[],
            );
            let close = async {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                pools.close("p2-pg").await;
            };
            let _ = tokio::join!(page, close);
            assert!(!pools.is_open("p2-pg"));
        })
    });
}

// ─── Missing-feature additions (2026-10-24) ───────────────────────

async fn f_exec(pool: &lotdb_lib::db::pool::DbPool, sql: &str) {
    pool.execute(sql)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// One text value (or NULL); the SQL casts it to text itself.
async fn f_text(pool: &lotdb_lib::db::pool::DbPool, sql: &str) -> Option<String> {
    use lotdb_lib::db::pool::DbPool;
    match pool {
        DbPool::MySQL(p) => sqlx::query_scalar(sql).fetch_one(p).await,
        DbPool::Postgres(p) => sqlx::query_scalar(sql).fetch_one(p).await,
    }
    .unwrap_or_else(|e| panic!("{sql}: {e}"))
}

/// Object-tree maintenance, CSV encodings / NULLs / BOM, PG database
/// options, EXPLAIN plans and transfer row totals, against a real server.
async fn feature_regressions(pools: &PoolManager, reg: &QueryRegistry, id: &str, mysql: bool) {
    use lotdb_lib::commands::admin::{
        create_database_impl, drop_database_impl, explain_query_impl,
    };
    use lotdb_lib::commands::table_ops::{copy_table_impl, drop_object_impl, rename_table_impl};
    use lotdb_lib::commands::transfer::{
        estimated_rows, exact_source_rows, export_table_data_impl, import_table_data_impl,
    };
    use lotdb_lib::utils::text_file::CsvOptions;

    let db = "lotdb_feat";
    let main = pools.pool(id).unwrap();
    if mysql {
        f_exec(&main, &format!("DROP DATABASE IF EXISTS {db}")).await;
    } else {
        f_exec(&main, &format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)")).await;
    }
    f_exec(&main, &format!("CREATE DATABASE {db}")).await;
    let pool = pools.pool_for(id, db).await.unwrap();
    let t = |name: &str| {
        if mysql {
            format!("`{db}`.`{name}`")
        } else {
            format!("\"{name}\"")
        }
    };
    let text = if mysql { "CHAR" } else { "TEXT" };
    let count = |name: &str| format!("SELECT CAST(COUNT(*) AS {text}) FROM {}", t(name));

    // Generated (and, on PG, GENERATED ALWAYS identity) columns must survive a copy.
    let create = if mysql {
        format!(
            "CREATE TABLE {} (id INT PRIMARY KEY, name VARCHAR(20) NULL, note VARCHAR(20) NULL, \
             doubled INT GENERATED ALWAYS AS (id * 2) STORED)",
            t("t")
        )
    } else {
        format!(
            "CREATE TABLE {} (id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT, note TEXT, \
             doubled INT GENERATED ALWAYS AS (id * 2) STORED)",
            t("t")
        )
    };
    f_exec(&pool, &create).await;
    let insert = if mysql {
        format!(
            "INSERT INTO {} (id, name, note) VALUES (1, 'a', NULL), (2, '', NULL), (3, NULL, 'x')",
            t("t")
        )
    } else {
        format!(
            "INSERT INTO {} (name, note) VALUES ('a', NULL), ('', NULL), (NULL, 'x')",
            t("t")
        )
    };
    f_exec(&pool, &insert).await;
    f_exec(
        &pool,
        &format!("CREATE VIEW {} AS SELECT id FROM {}", t("v"), t("t")),
    )
    .await;
    if mysql {
        f_exec(
            &pool,
            &format!(
                "CREATE FUNCTION {} () RETURNS INT DETERMINISTIC RETURN 1",
                t("f1")
            ),
        )
        .await;
        f_exec(&pool, &format!("CREATE PROCEDURE {} () SELECT 1", t("p1"))).await;
    } else {
        for sql in [
            "CREATE FUNCTION f1() RETURNS int LANGUAGE sql AS 'SELECT 1'",
            "CREATE PROCEDURE p1() LANGUAGE sql AS 'SELECT 1'",
            "CREATE FUNCTION over(int) RETURNS int LANGUAGE sql AS 'SELECT 1'",
            "CREATE FUNCTION over(text) RETURNS int LANGUAGE sql AS 'SELECT 2'",
        ] {
            f_exec(&pool, sql).await;
        }
    }

    // ── Copy / rename / drop ────────────────────────────────────────
    copy_table_impl(pools, id, db, None, "t", "t_full", true)
        .await
        .unwrap();
    assert_eq!(f_text(&pool, &count("t_full")).await.as_deref(), Some("3"));
    let doubled = format!("SELECT CAST(SUM(doubled) AS {text}) FROM {}", t("t_full"));
    assert_eq!(f_text(&pool, &doubled).await.as_deref(), Some("12"));
    copy_table_impl(pools, id, db, None, "t", "t_empty", false)
        .await
        .unwrap();
    assert_eq!(f_text(&pool, &count("t_empty")).await.as_deref(), Some("0"));
    assert!(copy_table_impl(pools, id, db, None, "t", "t_full", false)
        .await
        .is_err());

    rename_table_impl(pools, id, db, None, "t_empty", "t_renamed")
        .await
        .unwrap();
    assert_eq!(
        f_text(&pool, &count("t_renamed")).await.as_deref(),
        Some("0")
    );
    assert!(pool.execute(&count("t_empty")).await.is_err());

    for (kind, name) in [
        ("table", "t_renamed"),
        ("view", "v"),
        ("function", "f1"),
        ("function", "p1"),
    ] {
        drop_object_impl(pools, id, db, None, kind, name)
            .await
            .unwrap_or_else(|e| panic!("drop {kind} {name}: {e}"));
    }
    let routines = if mysql {
        format!("SELECT CAST(COUNT(*) AS CHAR) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '{db}'")
    } else {
        "SELECT COUNT(*)::text FROM pg_proc WHERE proname IN ('f1', 'p1')".to_string()
    };
    assert_eq!(f_text(&pool, &routines).await.as_deref(), Some("0"));
    if !mysql {
        let err = drop_object_impl(pools, id, db, None, "function", "over")
            .await
            .unwrap_err();
        assert!(err.message.contains("重载"), "{err}");
    }

    // ── CSV: BOM on export; "" vs NULL round-trips ──────────────────
    let dir = std::env::temp_dir().join(format!("lotdb-feat-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let csv = dir.join("t.csv").to_string_lossy().into_owned();
    export_table_data_impl(
        None,
        pools,
        id.into(),
        db.into(),
        None,
        "t".into(),
        "csv".into(),
        vec!["id".into(), "name".into(), "note".into()],
        None,
        0,
        csv.clone(),
        true,
    )
    .await
    .unwrap();
    let bytes = std::fs::read(&csv).unwrap();
    assert!(bytes.starts_with("\u{feff}\"id\"".as_bytes()), "{bytes:?}");

    f_exec(
        &pool,
        &format!(
            "CREATE TABLE {} (id INT PRIMARY KEY, name VARCHAR(20), note VARCHAR(20))",
            t("rt")
        ),
    )
    .await;
    let import = |path: String, options: CsvOptions| async move {
        import_table_data_impl(
            None,
            pools,
            id.into(),
            db.into(),
            None,
            "rt".into(),
            path,
            "csv".into(),
            true,
            false,
            vec![],
            options,
        )
        .await
        .unwrap()
    };
    let r = import(csv.clone(), CsvOptions::default()).await;
    assert_eq!((r.rows_imported, r.rows_failed), (3, 0), "{r:?}");
    let probe = |cond: &str| {
        format!(
            "SELECT CAST(COUNT(*) AS {text}) FROM {} WHERE {cond}",
            t("rt")
        )
    };
    assert_eq!(
        f_text(&pool, &probe("name IS NULL")).await.as_deref(),
        Some("1")
    );
    assert_eq!(
        f_text(&pool, &probe("name = ''")).await.as_deref(),
        Some("1")
    );
    assert_eq!(
        f_text(&pool, &probe("note IS NULL")).await.as_deref(),
        Some("2")
    );

    // GBK text, `\N` as NULL, empty fields kept as "", semicolons.
    let (gbk, _, _) = encoding_rs::GBK.encode("id;name;note\n10;张三;\\N\n11;;李四\n");
    let gbk_path = dir.join("gbk.csv");
    std::fs::write(&gbk_path, &gbk).unwrap();
    let r = import(
        gbk_path.to_string_lossy().into_owned(),
        CsvOptions {
            encoding: "gbk".into(),
            delimiter: ";".into(),
            empty_is_null: false,
            null_text: "\\N".into(),
        },
    )
    .await;
    assert_eq!((r.rows_imported, r.rows_failed), (2, 0), "{r:?}");
    assert_eq!(
        f_text(
            &pool,
            &format!("SELECT name FROM {} WHERE id = 10", t("rt"))
        )
        .await
        .as_deref(),
        Some("张三")
    );
    assert_eq!(
        f_text(&pool, &probe("id = 10 AND note IS NULL"))
            .await
            .as_deref(),
        Some("1")
    );
    assert_eq!(
        f_text(&pool, &probe("id = 11 AND name = ''"))
            .await
            .as_deref(),
        Some("1")
    );
    // The same bytes read as UTF-8 are refused, not imported as mojibake.
    let err = import_table_data_impl(
        None,
        pools,
        id.into(),
        db.into(),
        None,
        "rt".into(),
        gbk_path.to_string_lossy().into_owned(),
        "csv".into(),
        true,
        false,
        vec![],
        CsvOptions {
            delimiter: ";".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("UTF-8"), "{err}");

    // ── Transfer row totals ─────────────────────────────────────────
    assert_eq!(
        exact_source_rows(&pool, db, None, "t", None, 0)
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        exact_source_rows(&pool, db, None, "t", Some("id > 1"), 0)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        exact_source_rows(&pool, db, None, "t", None, 1)
            .await
            .unwrap(),
        1
    );
    if !mysql {
        f_exec(&pool, "ANALYZE t").await;
        assert_eq!(estimated_rows(&pool, db, None, "t").await, Some(3));
    }

    // ── EXPLAIN: a plan the graph view can draw ─────────────────────
    let session = format!("feat-{id}");
    let configure = if mysql {
        format!("USE {db}")
    } else {
        String::new()
    };
    if mysql {
        session_sql(pools, reg, id, &session, &configure, Some(0))
            .await
            .unwrap();
    }
    let target = if mysql { "t" } else { "lotdb_explain_probe" };
    if !mysql {
        // The PG session runs on the connection's default database.
        let _ = session_sql(
            pools,
            reg,
            id,
            &session,
            "DROP TABLE IF EXISTS lotdb_explain_probe",
            Some(0),
        )
        .await;
        session_sql(
            pools,
            reg,
            id,
            &session,
            "CREATE TABLE lotdb_explain_probe (id INT)",
            Some(0),
        )
        .await
        .unwrap();
    }
    let query = format!("SELECT * FROM {target} a JOIN {target} b ON a.id = b.id WHERE a.id > 1");
    for analyze in [false, true] {
        let plan = explain_query_impl(pools, reg, id, &query, analyze, Some(session.clone()), None)
            .await
            .unwrap_or_else(|e| panic!("explain analyze={analyze}: {e}"));
        if mysql {
            let tree = plan
                .tree
                .unwrap_or_else(|| panic!("no tree, analyze={analyze}"));
            assert!(tree.starts_with("->"), "{tree}");
            assert_eq!(plan.is_text, analyze);
            if analyze {
                assert!(tree.contains("actual time="), "{tree}");
            }
        } else {
            let root = &plan.plan.as_ref().expect("json plan")[0]["Plan"];
            assert!(root["Node Type"].is_string(), "{root}");
            assert_eq!(root.get("Actual Total Time").is_some(), analyze, "{root}");
        }
    }
    if !mysql {
        session_sql(
            pools,
            reg,
            id,
            &session,
            "DROP TABLE lotdb_explain_probe",
            Some(0),
        )
        .await
        .unwrap();
    }
    reg.close_sessions(id);

    // ── Create database with options ────────────────────────────────
    let db2 = "lotdb_feat2";
    let _ = drop_database_impl(pools, id.into(), db2.into()).await;
    if mysql {
        create_database_impl(pools, id, db2, Some("utf8mb4"), Some("utf8mb4_bin"), None)
            .await
            .unwrap();
        let collation = format!(
            "SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '{db2}'"
        );
        assert_eq!(
            f_text(&main, &collation).await.as_deref(),
            Some("utf8mb4_bin")
        );
    } else {
        let me = f_text(&main, "SELECT current_user::text").await.unwrap();
        create_database_impl(pools, id, db2, Some("UTF8"), Some("C"), Some(&me))
            .await
            .unwrap();
        let info = format!(
            "SELECT pg_encoding_to_char(encoding) || ' ' || datcollate || ' ' || pg_get_userbyid(datdba) \
             FROM pg_database WHERE datname = '{db2}'"
        );
        assert_eq!(f_text(&main, &info).await, Some(format!("UTF8 C {me}")));
    }
    drop_database_impl(pools, id.into(), db2.into())
        .await
        .unwrap();

    drop_database_impl(pools, id.into(), db.into())
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn mysql_feature_regressions() {
    let Some(mut cfg) = mysql_config() else {
        return;
    };
    cfg.id = "feat-mysql".into();
    let pools = PoolManager::new();
    pools.open(&cfg).await.unwrap();
    feature_regressions(&pools, &registry(), "feat-mysql", true).await;
}

#[tokio::test]
async fn pg_feature_regressions() {
    let Some(mut cfg) = pg_config() else {
        return;
    };
    cfg.id = "feat-pg".into();
    let pools = PoolManager::new();
    pools.open(&cfg).await.unwrap();
    feature_regressions(&pools, &registry(), "feat-pg", false).await;
}
