pub mod commands;
pub mod db;
pub mod models;
pub mod utils;

use db::pool::PoolManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PoolManager::new())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let pool = db::local_store::init_local_db(app_data_dir)
                    .await
                    .expect("failed to init local database");
                handle.manage(pool);
            });

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
            // Pool management + query execution
            commands::query::open_connection,
            commands::query::close_connection,
            commands::query::get_active_connections,
            commands::query::execute_query,
            commands::query::execute_query_with_params,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
