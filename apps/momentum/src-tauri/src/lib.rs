use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Build the prevent-default plugin.
/// CONTEXT_MENU is excluded so the DOM `contextmenu` event still fires,
/// allowing our React handlers to show native Tauri menus via `menu.popup()`.
#[cfg(debug_assertions)]
fn prevent_default() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_prevent_default::Flags;
    tauri_plugin_prevent_default::Builder::new()
        .with_flags(Flags::all().difference(Flags::DEV_TOOLS | Flags::RELOAD | Flags::CONTEXT_MENU))
        .build()
}

#[cfg(not(debug_assertions))]
fn prevent_default() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_prevent_default::Flags;
    tauri_plugin_prevent_default::Builder::new()
        .with_flags(Flags::all().difference(Flags::CONTEXT_MENU))
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The MCP bridge opens a WebSocket that can execute arbitrary JS and Tauri IPC in this app,
    // so it is compiled in for debug builds only and bound to loopback. The crate's own `init()`
    // binds 0.0.0.0, which would hand that control to anyone sharing the network.
    #[cfg(debug_assertions)]
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_devtools::init())
        .plugin(tauri_plugin_mcp_bridge::init_with_config(
            tauri_plugin_mcp_bridge::Config::localhost_only(),
        ));

    #[cfg(not(debug_assertions))]
    let builder = tauri::Builder::default();

    builder
        .plugin(prevent_default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Register updater plugin (desktop only, per Tauri v2 docs)
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Restore the user's zoom before the first frame, on Windows only.
            //
            // WHY RUST AND NOT THE WEBVIEW: `setZoom` from JS is async IPC, so a
            // level applied after React mounts paints one frame at 1.0 and then
            // jumps. `set_zoom` here runs before the page loads, and WebView2
            // treats a host-applied zoom as the new default that survives
            // navigation. The JS side only records the user's changes; this is
            // the side that makes them stick. Best-effort by design: a missing
            // store or key is a fresh install, never a reason to fail startup.
            //
            // Windows-only because WebView2 zoom is the only kind this app
            // offers. The Mac has none, and must not change.
            #[cfg(target_os = "windows")]
            {
                use tauri_plugin_store::StoreExt;
                if let Ok(store) = app.store("preferences.json") {
                    if let Some(zoom) = store.get("windows.zoom").and_then(|v| v.as_f64()) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_zoom(zoom);
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
