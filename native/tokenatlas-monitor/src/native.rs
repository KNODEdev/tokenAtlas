use crate::app::{self, Monitor, Prepared};
use anyhow::{Result, anyhow};
use egui_software_backend::{BufferMutRef, ColorFieldOrder, EguiSoftwareRender};
use std::{num::NonZeroU32, rc::Rc, time::Instant};
use winit::{
    application::ApplicationHandler,
    event::{ElementState, MouseButton, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop, OwnedDisplayHandle},
    window::{Window, WindowId},
};

#[derive(Default)]
struct RepaintTimer(Option<Instant>);
impl RepaintTimer {
    fn schedule(&mut self, when: Instant) {
        self.0 = Some(self.0.map_or(when, |prior| prior.min(when)));
    }
    fn take_due(&mut self, now: Instant) -> bool {
        if self.0.is_some_and(|when| when <= now) {
            self.0 = None;
            true
        } else {
            false
        }
    }
}
struct Surface {
    // Drop the Wayland clipboard before its window/display resources.
    input: egui_winit::State,
    pixels: softbuffer::Surface<OwnedDisplayHandle, Rc<Window>>,
    window: Rc<Window>,
    cursor: Option<winit::dpi::PhysicalPosition<f64>>,
}
#[derive(Debug)]
pub enum UserEvent {
    Repaint(Instant),
    Restore,
    Quit,
}
fn work_area(window: &Window) -> Option<egui::Rect> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Gdi::{
            GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
        };
        use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
        if let Ok(handle) = window.window_handle()
            && let RawWindowHandle::Win32(handle) = handle.as_raw()
        {
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            // The work area excludes the taskbar; this never changes desktop settings.
            unsafe {
                let monitor = MonitorFromWindow(handle.hwnd.get() as _, MONITOR_DEFAULTTONEAREST);
                if GetMonitorInfoW(monitor, &mut info) != 0 {
                    return Some(egui::Rect::from_min_max(
                        egui::pos2(info.rcWork.left as f32, info.rcWork.top as f32),
                        egui::pos2(info.rcWork.right as f32, info.rcWork.bottom as f32),
                    ));
                }
            }
        }
    }
    window.current_monitor().map(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        egui::Rect::from_min_size(
            egui::pos2(position.x as f32, position.y as f32),
            egui::vec2(
                size.width as f32,
                size.height as f32 - crate::theme::GAP * 4.0 * window.scale_factor() as f32,
            ),
        )
    })
}
fn available_height(window: &Window) -> f32 {
    work_area(window).map_or(f32::INFINITY, |area| {
        area.height() / window.scale_factor() as f32
    })
}
fn keep_in_work_area(window: &Window, size: egui::Vec2) {
    if let Some(area) = work_area(window)
        && let Ok(position) = window.outer_position()
    {
        let size = size * window.scale_factor() as f32;
        let x = (position.x as f32).clamp(area.left(), (area.right() - size.x).max(area.left()));
        let y = (position.y as f32).clamp(area.top(), (area.bottom() - size.y).max(area.top()));
        if position.x != x as i32 || position.y != y as i32 {
            window.set_outer_position(winit::dpi::PhysicalPosition::new(x as i32, y as i32));
        }
    }
}
struct Native {
    ctx: egui::Context,
    surface: Option<Surface>,
    monitor: Option<Monitor>,
    prepared: Option<Prepared>,
    renderer: EguiSoftwareRender,
    display: softbuffer::Context<OwnedDisplayHandle>,
    timer: RepaintTimer,
    started: Instant,
    error: Option<String>,
    hidden: bool,
    frames: u64,
    tray: Option<tray_icon::TrayIcon>,
    in_tray: bool,
    exit_at: Option<Instant>,
}
impl Native {
    fn fail(&mut self, event_loop: &ActiveEventLoop, error: impl std::fmt::Display) {
        self.error = Some(error.to_string());
        event_loop.exit();
    }
    fn draw(&mut self) -> Result<bool> {
        let Some(surface) = self.surface.as_mut() else {
            return Ok(false);
        };
        let size = surface.window.inner_size();
        let (Some(width), Some(height)) =
            (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
        else {
            return Ok(false);
        };
        surface
            .pixels
            .resize(width, height)
            .map_err(|e| anyhow!("Resize buffer: {e}"))?;
        let mut input = surface.input.take_egui_input(&surface.window);
        input.time = Some(self.started.elapsed().as_secs_f64());
        let monitor = self
            .monitor
            .as_mut()
            .expect("monitor initialized before drawing");
        monitor.set_max_height(available_height(&surface.window));
        let output = self.ctx.run(input, |ctx| monitor.render(ctx));
        self.frames += 1;
        surface
            .input
            .handle_platform_output(&surface.window, output.platform_output);
        let shapes = self.ctx.tessellate(output.shapes, output.pixels_per_point);
        let mut buffer = surface
            .pixels
            .buffer_mut()
            .map_err(|e| anyhow!("Open buffer: {e}"))?;
        self.renderer.render(
            &mut BufferMutRef::new(
                bytemuck::cast_slice_mut(&mut buffer),
                width.get() as usize,
                height.get() as usize,
            ),
            &shapes,
            &output.textures_delta,
            output.pixels_per_point,
        );
        buffer
            .present()
            .map_err(|e| anyhow!("Present buffer: {e}"))?;
        if let Some(viewport) = output.viewport_output.get(&egui::ViewportId::ROOT) {
            for command in &viewport.commands {
                match command {
                    egui::ViewportCommand::WindowLevel(level) => {
                        surface.window.set_window_level(match level {
                            egui::WindowLevel::AlwaysOnTop => {
                                winit::window::WindowLevel::AlwaysOnTop
                            }
                            egui::WindowLevel::AlwaysOnBottom => {
                                winit::window::WindowLevel::AlwaysOnBottom
                            }
                            egui::WindowLevel::Normal => winit::window::WindowLevel::Normal,
                        })
                    }
                    egui::ViewportCommand::Close => return Ok(true),
                    egui::ViewportCommand::Minimized(minimized) => {
                        if *minimized && self.tray.is_some() {
                            #[cfg(windows)]
                            {
                                use winit::platform::windows::WindowExtWindows;
                                surface.window.set_skip_taskbar(true);
                            }
                            surface.window.set_visible(false);
                            self.in_tray = true;
                        } else {
                            surface.window.set_minimized(*minimized);
                        }
                    }
                    egui::ViewportCommand::InnerSize(size) => {
                        let _ = surface
                            .window
                            .request_inner_size(winit::dpi::LogicalSize::new(size.x, size.y));
                        keep_in_work_area(&surface.window, *size);
                    }
                    _ => {}
                }
            }
        }
        Ok(false)
    }
}
impl ApplicationHandler<UserEvent> for Native {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.surface.is_some() {
            return;
        }
        let result = (|| -> Result<Surface> {
            let image =
                image::load_from_memory(include_bytes!("../assets/tokenatlas-monitor.png"))?
                    .into_rgba8();
            let (icon_width, icon_height) = image.dimensions();
            let icon = winit::window::Icon::from_rgba(image.into_raw(), icon_width, icon_height)?;
            let size = self
                .monitor
                .as_ref()
                .map(Monitor::window_size)
                .or_else(|| self.prepared.as_ref().map(Prepared::window_size))
                .unwrap_or_else(|| app::window_size(1));
            let window = Rc::new(
                event_loop.create_window(
                    Window::default_attributes()
                        .with_title("tokenAtlas")
                        .with_window_icon(Some(icon))
                        .with_decorations(false)
                        .with_visible(!self.hidden && !self.in_tray)
                        .with_inner_size(winit::dpi::LogicalSize::new(size.x, size.y))
                        .with_resizable(false),
                )?,
            );
            let input = egui_winit::State::new(
                self.ctx.clone(),
                egui::ViewportId::ROOT,
                &window,
                Some(window.scale_factor() as f32),
                window.theme(),
                None,
            );
            let pixels = softbuffer::Surface::new(&self.display, window.clone())
                .map_err(|e| anyhow!("Create buffer: {e}"))?;
            Ok(Surface {
                input,
                pixels,
                window,
                cursor: None,
            })
        })();
        match result {
            Ok(surface) => {
                if self.monitor.is_none() {
                    self.monitor = Some(Monitor::new(
                        &self.ctx,
                        self.prepared.take().expect("initial setup"),
                    ));
                }
                surface.window.set_window_level(
                    if self.monitor.as_ref().is_some_and(Monitor::always_on_top) {
                        winit::window::WindowLevel::AlwaysOnTop
                    } else {
                        winit::window::WindowLevel::Normal
                    },
                );
                surface.window.request_redraw();
                self.surface = Some(surface);
                #[cfg(windows)]
                if self.in_tray {
                    use winit::platform::windows::WindowExtWindows;
                    self.surface.as_ref().unwrap().window.set_skip_taskbar(true);
                }
                if !self.hidden && self.tray.is_none() {
                    match crate::tray::create() {
                        Ok(tray) => self.tray = Some(tray),
                        Err(error) => {
                            if let Some(monitor) = &mut self.monitor {
                                monitor.native_error(format!("Zasobnik niedostępny: {error}"));
                            }
                        }
                    }
                }
                if self.hidden {
                    self.timer.schedule(Instant::now());
                }
            }
            Err(e) => self.fail(event_loop, e),
        }
    }
    fn suspended(&mut self, _: &ActiveEventLoop) {
        self.surface = None;
    }
    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Repaint(when) => self.timer.schedule(when),
            UserEvent::Quit => event_loop.exit(),
            UserEvent::Restore => {
                self.in_tray = false;
                if let Some(surface) = &self.surface {
                    #[cfg(windows)]
                    {
                        use winit::platform::windows::WindowExtWindows;
                        surface.window.set_skip_taskbar(false);
                    }
                    surface.window.set_minimized(false);
                    surface.window.set_visible(true);
                    surface.window.focus_window();
                    surface.window.request_redraw();
                }
            }
        }
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        let Some(surface) = self.surface.as_mut().filter(|s| s.window.id() == id) else {
            return;
        };
        if matches!(event, WindowEvent::CloseRequested) {
            event_loop.exit();
            return;
        }
        if matches!(event, WindowEvent::Resized(_))
            && surface.window.is_minimized() == Some(true)
            && self.tray.is_some()
        {
            #[cfg(windows)]
            {
                use winit::platform::windows::WindowExtWindows;
                surface.window.set_skip_taskbar(true);
            }
            surface.window.set_visible(false);
            self.in_tray = true;
            return;
        }
        if let WindowEvent::CursorMoved { position, .. } = &event {
            surface.cursor = Some(*position);
        }
        // Native dragging must begin on the press event, before egui's deferred redraw.
        if matches!(
            event,
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            }
        ) && let Some(cursor) = surface.cursor
            && self.monitor.as_ref().is_some_and(|monitor| {
                let scale = self.ctx.pixels_per_point();
                monitor.title_bar_contains(
                    &self.ctx,
                    egui::pos2(cursor.x as f32 / scale, cursor.y as f32 / scale),
                )
            })
        {
            if let Err(error) = surface.window.drag_window() {
                eprintln!("Cannot move monitor window: {error}");
            }
            return;
        }
        let repaint = surface
            .input
            .on_window_event(&surface.window, &event)
            .repaint;
        if matches!(event, WindowEvent::RedrawRequested) && !self.in_tray {
            match self.draw() {
                Ok(true) => event_loop.exit(),
                Err(e) => self.fail(event_loop, e),
                Ok(false) => {}
            }
        } else if repaint {
            surface.window.request_redraw();
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self
            .exit_at
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            event_loop.exit();
            return;
        }
        if self.timer.take_due(Instant::now())
            && let Some(surface) = &self.surface
        {
            if self.hidden {
                match self.draw() {
                    Ok(true) => event_loop.exit(),
                    Err(e) => self.fail(event_loop, e),
                    Ok(false) => {}
                }
            } else if !self.in_tray {
                surface.window.request_redraw();
            }
        }
        let wake = self.timer.0.into_iter().chain(self.exit_at).min();
        event_loop.set_control_flow(wake.map_or(ControlFlow::Wait, ControlFlow::WaitUntil));
    }
}
pub fn run(prepared: Prepared) -> Result<()> {
    let hidden = prepared.measure_hidden();
    let exit_at = prepared
        .exit_after()
        .map(|duration| Instant::now() + duration);
    let event_loop = EventLoop::<UserEvent>::with_user_event().build()?;
    let proxy = event_loop.create_proxy();
    crate::tray::install_handlers(proxy.clone());
    let ctx = egui::Context::default();
    ctx.set_request_repaint_callback(move |info| {
        if let Some(when) = Instant::now().checked_add(info.delay) {
            let _ = proxy.send_event(UserEvent::Repaint(when));
        }
    });
    let display = softbuffer::Context::new(event_loop.owned_display_handle())
        .map_err(|e| anyhow!("Create display: {e}"))?;
    let mut native = Native {
        ctx,
        surface: None,
        monitor: None,
        prepared: Some(prepared),
        renderer: EguiSoftwareRender::new(ColorFieldOrder::Bgra),
        display,
        timer: RepaintTimer::default(),
        started: Instant::now(),
        error: None,
        hidden,
        frames: 0,
        tray: None,
        in_tray: false,
        exit_at,
    };
    event_loop.run_app(&mut native)?;
    if let Some(error) = native.error.take() {
        return Err(anyhow!(error));
    }
    if hidden {
        println!(
            "{}",
            serde_json::json!({"hidden":true,"frames":native.frames,"seconds":native.started.elapsed().as_secs_f64()})
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn delayed_repaint_does_not_draw_immediately_and_worker_wake_keeps_the_earliest_deadline() {
        let now = Instant::now();
        let mut timer = RepaintTimer::default();
        timer.schedule(now + Duration::from_secs(60));
        assert!(!timer.take_due(now));
        timer.schedule(now + Duration::from_secs(90));
        assert_eq!(timer.0, Some(now + Duration::from_secs(60)));
        timer.schedule(now);
        assert!(timer.take_due(now));
        assert!(!timer.take_due(now));
        assert!(timer.0.is_none());
    }
}
