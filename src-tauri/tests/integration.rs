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
    )
    .await
    .unwrap_err();
    assert!(denied.contains("只读"), "deny before reading or truncating");
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
    assert!(denied.contains("只读"));
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
