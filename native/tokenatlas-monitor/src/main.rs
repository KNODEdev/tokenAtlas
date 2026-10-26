#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod app;
mod collector;
mod common;
mod model;
mod native;
mod store;
mod theme;
mod tray;
mod trend;
mod worker;

use anyhow::{Context, Result, bail};
use std::{path::PathBuf, time::Duration};

#[derive(Default)]
pub struct Options {
    data_dir: Option<PathBuf>,
    demo: bool,
    once: bool,
    preview: Option<PathBuf>,
    exit_after: Option<Duration>,
    selected: Vec<String>,
    list_profiles: bool,
    dark: Option<bool>,
    measure_hidden: bool,
    atlas_root: Option<PathBuf>,
}

impl Options {
    fn parse() -> Result<Self> {
        let mut out = Self::default();
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--data-dir" => {
                    out.data_dir = Some(args.next().context("--data-dir needs a path")?.into())
                }
                "--demo" => out.demo = true,
                "--atlas-root" => {
                    out.atlas_root = Some(args.next().context("--atlas-root needs a path")?.into())
                }
                "--measure-hidden" => out.measure_hidden = true,
                "--once" => out.once = true,
                "--select" => out
                    .selected
                    .push(args.next().context("--select needs an account ID")?),
                "--list-profiles" => out.list_profiles = true,
                "--theme" => {
                    out.dark = Some(match args.next().as_deref() {
                        Some("dark") => true,
                        Some("light") => false,
                        _ => bail!("--theme light|dark"),
                    })
                }
                "--preview" => {
                    out.preview = Some(args.next().context("--preview needs a PNG path")?.into())
                }
                "--exit-after" => {
                    out.exit_after = Some(Duration::from_secs(
                        args.next().context("--exit-after needs seconds")?.parse()?,
                    ))
                }
                "--help" | "-h" => {
                    println!(
                        "tokenatlas-monitor [--atlas-root PATH] [--data-dir PATH] [--demo] [--once] [--select ID] [--list-profiles] [--theme light|dark] [--preview PNG] [--exit-after SECONDS]"
                    );
                    std::process::exit(0);
                }
                _ => bail!("Unknown option: {arg}"),
            }
        }
        if out.demo && out.data_dir.is_none() {
            bail!("--demo requires a separate --data-dir (real data is never used by a demo)");
        }
        if out.preview.is_some() && !out.demo {
            bail!("--preview requires --demo; no credentials or desktop window are opened");
        }
        if out.measure_hidden
            && (!out.demo
                || out.preview.is_some()
                || out.once
                || out
                    .exit_after
                    .is_none_or(|d| !(15..=300).contains(&d.as_secs())))
        {
            bail!("--measure-hidden requires --demo --exit-after 15..300; no preview/once");
        }
        Ok(out)
    }

    fn root(&self) -> Result<PathBuf> {
        if let Some(root) = self
            .data_dir
            .clone()
            .or_else(|| std::env::var_os("TOKENATLAS_MONITOR_HOME").map(PathBuf::from))
        {
            return Ok(std::path::absolute(root)?);
        }
        Ok(
            directories::ProjectDirs::from("dev", "tokenAtlas", "tokenAtlas Monitor")
                .context("Cannot find a local data directory; use --data-dir")?
                .data_local_dir()
                .to_owned(),
        )
    }
}

fn run() -> Result<()> {
    let options = Options::parse()?;
    if options.list_profiles {
        let profiles = if options.demo {
            common::demo_profiles()
        } else {
            common::Register::open(options.atlas_root.as_deref())?.profiles
        };
        let safe = profiles
            .iter()
            .map(|p| serde_json::json!({"id":p.id,"provider":p.provider.name(),"label":p.label}))
            .collect::<Vec<_>>();
        println!("{}", serde_json::to_string(&safe)?);
        return Ok(());
    }
    let root = options.root()?;
    let store = if options.demo {
        store::Store::open(&root)?
    } else {
        store::Store::open_settings(&root)?
    };
    store.mode(options.demo)?;
    if options.once {
        let mut store = store;
        let mut settings = store.settings()?;
        if options.demo {
            worker::seed_demo(&mut store, &mut settings)?;
        }
        if !options.selected.is_empty() {
            settings.selected = options.selected.clone();
            settings
                .panels
                .retain(|p| settings.selected.contains(&p.account));
            settings.validate()?;
            store.save_settings(&settings)?;
        }
        if !options.demo {
            let mut shared = common::Register::open(
                options
                    .atlas_root
                    .as_deref()
                    .or(settings.atlas_root.as_deref()),
            )?;
            shared.migrate_selection(&mut settings, &store.known_profiles()?);
            settings.ensure_panels(&shared.profiles);
            settings.atlas_root = Some(shared.root.clone());
            store.save_settings(&settings)?;
            let views=settings.panels.iter().map(|panel| {
                let profile=shared.profiles.iter().find(|p|p.id==panel.account).cloned().context("Wybrany abonament jest niedostępny")?;
                let v=shared.view_meter(&profile,panel.meter.as_ref())?;
                let meter=common::choose_meter(&v.meters,v.points.keys().next());
                let estimate=meter.map(|m|trend::Estimate::new(m,v.at,v.rate_basis,v.bounds,model::now_ms(),settings.interval_minutes)).unwrap_or_default();
                Ok(serde_json::json!({"panel":panel.id,"account":profile.id,"meter":v.points.keys().next(),"source_points":v.source_points,"displayed_points":v.points.values().map(Vec::len).sum::<usize>(),"rate_available":estimate.percent_per_hour.is_some(),"eta_available":estimate.ceiling_at.is_some()}))
            })
                .collect::<Result<Vec<_>>>()?;
            println!(
                "{}",
                serde_json::json!({"source":"shared-register","panels":views})
            );
            return Ok(());
        }
        let profiles = common::demo_profiles();
        if settings.selected.is_empty() {
            bail!("Najpierw wybierz konta w oknie monitora");
        }
        let failed = settings
            .selected
            .iter()
            .filter(|id| !profiles.iter().any(|p| &p.id == *id))
            .count();
        let errors = Vec::<serde_json::Value>::new();
        println!(
            "{}",
            serde_json::json!({"failed":failed,"stored":store.count()?,"errors":errors})
        );
        if failed > 0 {
            bail!("Some accounts could not be read");
        }
        return Ok(());
    }
    let preview_path = options.preview.clone();
    let prepared = app::Prepared::new(store, options)?;
    if let Some(path) = preview_path {
        return preview(prepared, &path);
    }
    native::run(prepared)
}

fn preview(prepared: app::Prepared, path: &std::path::Path) -> Result<()> {
    use egui_software_backend::{BufferMutRef, ColorFieldOrder, EguiSoftwareRender};
    let ctx = egui::Context::default();
    let mut size = prepared.window_size();
    let mut monitor = app::Monitor::new(&ctx, prepared);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !monitor.ready() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !monitor.ready() {
        bail!("Demo did not become ready");
    }
    let mut pixels = Vec::new();
    let mut dimensions = (0, 0);
    let mut renderer = EguiSoftwareRender::new(ColorFieldOrder::Rgba);
    for frame in 0..4 {
        let output = ctx.run(
            egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(egui::Pos2::ZERO, size)),
                time: Some(frame as f64 / 60.0),
                ..Default::default()
            },
            |ctx| monitor.render(ctx),
        );
        let shapes = ctx.tessellate(output.shapes, output.pixels_per_point);
        dimensions = (size.x as usize, size.y as usize);
        let (width, height) = dimensions;
        pixels.resize(width * height, [0u8; 4]);
        renderer.render(
            &mut BufferMutRef::new(&mut pixels, width, height),
            &shapes,
            &output.textures_delta,
            output.pixels_per_point,
        );
        size = monitor.window_size();
    }
    let bytes = pixels.into_iter().flatten().collect::<Vec<_>>();
    image::save_buffer(
        path,
        &bytes,
        dimensions.0 as u32,
        dimensions.1 as u32,
        image::ColorType::Rgba8,
    )?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("tokenAtlas monitor: {error:#}");
        #[cfg(windows)]
        if !std::env::args().any(|a| {
            matches!(
                a.as_str(),
                "--once" | "--help" | "--list-profiles" | "--exit-after" | "--preview"
            )
        }) {
            let message = format!("{error:#}\0").encode_utf16().collect::<Vec<_>>();
            let title = "tokenAtlas monitor\0".encode_utf16().collect::<Vec<_>>();
            // A desktop launch has no console: surface startup/storage failures in its own dialog.
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
                    std::ptr::null_mut(),
                    message.as_ptr(),
                    title.as_ptr(),
                    0x10,
                );
            }
        }
        // Window-start failures remain discoverable when launched from the desktop.
        std::process::exit(1);
    }
}
