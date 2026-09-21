use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
        .plugin(tauri_plugin_opener::init())
        // Remembers window size, position, monitor, and maximized/fullscreen
        // state across launches — restored automatically on startup.
        .plugin(tauri_plugin_window_state::Builder::default().build())
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

            // Desktop only, per the Tauri v2 docs: the updater has no mobile
            // implementation, so registering it unconditionally breaks a mobile
            // build. Same shape as Momentum's.
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
                            // Clamped to the range the app itself writes. A hand-edited
                            // or corrupted store must not be able to open the window
                            // at 40x, where nothing on it could be clicked to fix it.
                            let _ = window.set_zoom(zoom.clamp(1.0, 1.5));
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
