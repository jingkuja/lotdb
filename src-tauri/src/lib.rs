pub mod commands;
pub mod db;
pub mod error;
pub mod models;
pub mod utils;

use commands::query::QueryRegistry;
use db::pool::PoolManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PoolManager::new())
        .manage(QueryRegistry::default())
        .setup(|app| {
            // Must finish before the webview mounts: the packaged app loads
            // instantly and immediately invokes get_connections / list_groups.
            // Spawning this work raced the first IPC calls and left the UI
            // stuck on "加载中" (state not managed, or a hung sqlite connect).
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
            let pool = tauri::async_runtime::block_on(db::local_store::init_local_db(app_data_dir))
                .map_err(|e| format!("failed to init local database: {e}"))?;
            app.manage(pool);

            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Connection CRUD
            commands::connection::create_connection,
            commands::connection::get_connections,
            commands::connection::update_connection,
            commands::connection::delete_connection,
            commands::connection::test_connection,
            commands::connection::import_connections,
            // Pool management + query execution
            commands::query::open_connection,
            commands::query::close_connection,
            commands::query::get_active_connections,
            commands::query::execute_query,
            commands::query::execute_query_with_params,
            commands::query::cancel_query,
            commands::query::close_query_session,
            // Schema / object browser
            commands::schema::list_databases,
            commands::schema::list_schemas,
            commands::schema::list_objects,
            // Table structure
            commands::schema::get_table_columns,
            commands::schema::get_table_indexes,
            commands::schema::get_table_foreign_keys,
            // Object search
            commands::schema::search_objects,
            // Autocomplete schema
            commands::schema::get_completion_schema,
            // Object DDL / triggers / sequences / enums
            commands::objects::get_view_ddl,
            commands::objects::get_function_ddl,
            commands::objects::list_triggers,
            commands::objects::get_trigger_ddl,
            commands::objects::drop_trigger,
            commands::objects::list_sequences,
            commands::objects::create_sequence,
            commands::objects::restart_sequence,
            commands::objects::drop_sequence,
            commands::objects::list_enums,
            commands::objects::create_enum_type,
            commands::objects::add_enum_value,
            commands::objects::drop_enum_type,
            // Connection groups
            commands::groups::list_groups,
            commands::groups::create_group,
            commands::groups::rename_group,
            commands::groups::delete_group,
            // Query history
            commands::history::save_history,
            commands::history::get_history,
            commands::history::delete_history,
            commands::history::clear_history,
            // Snippets
            commands::snippets::get_snippets,
            commands::snippets::create_snippet,
            commands::snippets::update_snippet,
            commands::snippets::delete_snippet,
            // Table data
            commands::data::get_table_data,
            commands::data::execute_statements,
            // Export / Import
            commands::transfer::export_table_data,
            commands::transfer::batch_export_tables,
            commands::transfer::preview_import_file,
            commands::transfer::import_table_data,
            commands::transfer::transfer_table_data,
            // Database management
            commands::admin::create_database,
            commands::admin::drop_database,
            // User management
            commands::admin::list_users,
            commands::admin::get_user_grants,
            commands::admin::create_user,
            commands::admin::drop_user,
            commands::admin::grant_privilege,
            commands::admin::revoke_privilege,
            // Process list & kill
            commands::admin::list_processes,
            commands::admin::kill_process,
            // Disk usage
            commands::admin::get_disk_usage,
            commands::admin::get_table_sizes,
            // Explain
            commands::admin::explain_query,
            // Backup / Restore
            commands::backup::backup_database,
            commands::backup::restore_database,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
