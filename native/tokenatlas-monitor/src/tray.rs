use anyhow::Result;
use tray_icon::{
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem},
};
use winit::event_loop::EventLoopProxy;

use crate::native::UserEvent;

pub fn install_handlers(proxy: EventLoopProxy<UserEvent>) {
    let clicks = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |event| {
        if matches!(
            event,
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
        ) {
            let _ = clicks.send_event(UserEvent::Restore);
        }
    }));
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let action = match event.id.as_ref() {
            "show" => UserEvent::Restore,
            "quit" => UserEvent::Quit,
            _ => return,
        };
        let _ = proxy.send_event(action);
    }));
}

pub fn create() -> Result<TrayIcon> {
    #[cfg(target_os = "linux")]
    {
        let connection = zbus::blocking::connection::Builder::session()?
            .method_timeout(std::time::Duration::from_secs(1))
            .build()?;
        let watcher = zbus::blocking::Proxy::new(
            &connection,
            "org.kde.StatusNotifierWatcher",
            "/StatusNotifierWatcher",
            "org.kde.StatusNotifierWatcher",
        )?;
        // The tray backend assumes SNI exists; never hide the only window on that assumption.
        if !watcher.get_property::<bool>("IsStatusNotifierHostRegistered")? {
            anyhow::bail!("Brak aktywnego zasobnika StatusNotifier");
        }
    }
    let menu = Menu::new();
    menu.append_items(&[
        &MenuItem::with_id("show", "pokaż tokenAtlas", true, None),
        &MenuItem::with_id("quit", "zakończ", true, None),
    ])?;
    let image = image::load_from_memory(include_bytes!("../assets/tokenatlas-monitor.png"))?
        .resize(32, 32, image::imageops::FilterType::Lanczos3)
        .into_rgba8();
    Ok(TrayIconBuilder::new()
        .with_tooltip("tokenAtlas Monitor")
        .with_icon(Icon::from_rgba(image.into_raw(), 32, 32)?)
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .build()?)
}
