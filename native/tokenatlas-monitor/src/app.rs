use crate::{
    Options,
    model::{MAX_PANELS, Meter, PanelChoice, Profile, Provider, Settings, now_ms, segments_in},
    store::Store,
    theme,
    trend::Estimate,
    worker::{self, AccountView, Command, Snapshot, Worker},
};
use anyhow::Result;
use egui::{Align2, Color32, FontId, Pos2, Rect, RichText, Sense, Stroke, Vec2};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

pub const WIDTH: f32 = 360.0;
pub fn window_size(panels: usize) -> Vec2 {
    Vec2::new(WIDTH, 48.0 + 280.0 * panels.clamp(1, 2) as f32)
}

// Finish all fallible storage work before opening the native event loop.
pub struct Prepared {
    store: Store,
    settings: Settings,
    options: Options,
    shared: Option<crate::common::Register>,
}
impl Prepared {
    pub fn window_size(&self) -> Vec2 {
        window_size(self.settings.panels.len())
    }
    pub fn measure_hidden(&self) -> bool {
        self.options.measure_hidden
    }
    pub fn exit_after(&self) -> Option<Duration> {
        self.options.exit_after
    }
    pub fn new(mut store: Store, options: Options) -> Result<Self> {
        store.mode(options.demo)?;
        let mut settings = store.settings()?;
        if options.demo {
            worker::seed_demo(&mut store, &mut settings)?;
        }
        if !options.selected.is_empty() {
            settings.selected = options.selected.clone();
            settings
                .panels
                .retain(|p| settings.selected.contains(&p.account));
        }
        if let Some(dark) = options.dark {
            settings.dark = dark;
        }
        if let Some(root) = &options.atlas_root {
            settings.atlas_root = Some(root.clone());
        }
        let shared = if !options.demo {
            let shared = crate::common::Register::open(settings.atlas_root.as_deref())?;
            shared.migrate_selection(&mut settings, &store.known_profiles()?);
            settings.atlas_root = Some(shared.root.clone());
            Some(shared)
        } else {
            None
        };
        settings.ensure_panels(
            &shared
                .as_ref()
                .map(|s| s.profiles.clone())
                .unwrap_or_else(crate::common::demo_profiles),
        );
        settings.validate()?;
        store.save_settings(&settings)?;
        Ok(Self {
            store,
            settings,
            options,
            shared,
        })
    }
}

pub struct Monitor {
    worker: Worker,
    settings: Settings,
    root: PathBuf,
    options: Options,
    started: Instant,
    settings_open: bool,
    new_home: String,
    local_error: Option<String>,
    drag_region: Option<(Rect, egui::LayerId)>,
    size: Vec2,
    max_height: f32,
    content_height: f32,
    icon: egui::TextureHandle,
}

impl Monitor {
    pub fn window_size(&self) -> Vec2 {
        self.size
    }
    pub fn set_max_height(&mut self, height: f32) {
        self.max_height = height;
    }
    pub fn native_error(&mut self, error: String) {
        self.local_error = Some(error);
    }
    pub fn always_on_top(&self) -> bool {
        self.settings.always_on_top
    }
    pub fn new(ctx: &egui::Context, prepared: Prepared) -> Self {
        let Prepared {
            store,
            settings,
            options,
            shared,
        } = prepared;
        theme::install(ctx, settings.dark);
        let icon = image::load_from_memory(include_bytes!("../assets/tokenatlas-monitor.png"))
            .expect("bundled application icon")
            .into_rgba8();
        let icon = ctx.load_texture(
            "application-icon",
            egui::ColorImage::from_rgba_unmultiplied(
                [icon.width() as usize, icon.height() as usize],
                icon.as_raw(),
            ),
            egui::TextureOptions::LINEAR,
        );
        ctx.send_viewport_cmd(egui::ViewportCommand::WindowLevel(
            if settings.always_on_top {
                egui::WindowLevel::AlwaysOnTop
            } else {
                egui::WindowLevel::Normal
            },
        ));
        let root = store.root().to_owned();
        let size = window_size(settings.panels.len());
        let worker = Worker::start(store, settings.clone(), options.demo, ctx.clone(), shared);
        Self {
            worker,
            settings,
            root,
            options,
            started: Instant::now(),
            settings_open: false,
            new_home: String::new(),
            local_error: None,
            drag_region: None,
            size,
            max_height: f32::INFINITY,
            content_height: 0.0,
            icon,
        }
    }
    fn configure(&self) {
        let _ = self
            .worker
            .tx
            .send(Command::Configure(self.settings.clone()));
    }
    pub fn ready(&self) -> bool {
        let state = self
            .worker
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        !state.profiles.is_empty() && !state.busy && !state.accounts.is_empty()
    }
    pub fn render(&mut self, ctx: &egui::Context) {
        let state = self
            .worker
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let header_height = self.title_bar(ctx, &state);
        let mut measured_height = 0.0;
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(theme::token("band", self.settings.dark))
                    .inner_margin(theme::GAP),
            )
            .show(ctx, |ui| {
                let start = ui.cursor().min.y;
                if let Some(error) = self.local_error.as_ref().or(state.error.as_ref()) {
                    ui.label(
                        RichText::new("błąd")
                            .small()
                            .color(theme::token("crit", self.settings.dark)),
                    )
                    .on_hover_text(error);
                }
                let chosen: Vec<_> = state
                    .profiles
                    .iter()
                    .filter(|p| self.settings.selected.contains(&p.id))
                    .collect();
                if self.settings.panels.is_empty() {
                    ui.horizontal(|ui| {
                        ui.strong("tokenAtlas");
                        if ui.button("wybierz konta").clicked() {
                            self.settings_open = true;
                        }
                    });
                    ui.add_space(theme::GAP);
                    ui.label(RichText::new("—").size(theme::FIGURE));
                } else {
                    let prefix = ui.cursor().min.y - start;
                    let scroll = self.settings.panels.len() > 2
                        || self.content_height + header_height + 2.0 * theme::GAP > self.max_height;
                    let (first_two, total) = if scroll {
                        egui::ScrollArea::vertical()
                            .auto_shrink([false, false])
                            .show(ui, |ui| self.cards(ui, &state, &chosen))
                            .inner
                    } else {
                        self.cards(ui, &state, &chosen)
                    };
                    self.content_height = prefix + total;
                    measured_height = prefix + first_two;
                }
            });
        if measured_height > 0.0 {
            let height = (header_height + 2.0 * theme::GAP + measured_height).ceil();
            let height = height.min(self.max_height);
            if (height - self.size.y).abs() > 1.0 {
                self.size.y = height;
                ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(self.size));
                ctx.request_repaint();
            }
        }
        self.settings_panel(ctx, &state);
        let mut repaint = Duration::from_secs(60);
        if let Some(limit) = self.options.exit_after {
            if self.started.elapsed() >= limit {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            repaint = repaint.min(limit.saturating_sub(self.started.elapsed()));
        }
        ctx.request_repaint_after(repaint);
    }
    pub fn title_bar_contains(&self, ctx: &egui::Context, point: Pos2) -> bool {
        self.drag_region.is_some_and(|(rect, layer)| {
            rect.contains(point) && ctx.layer_id_at(point) == Some(layer)
        })
    }
    fn cards(&mut self, ui: &mut egui::Ui, state: &Snapshot, chosen: &[&Profile]) -> (f32, f32) {
        let start = ui.cursor().min.y;
        let mut first_two = 0.0;
        let mut total = 0.0;
        for (index, panel) in self.settings.panels.clone().iter().enumerate() {
            if index > 0 {
                ui.separator();
                ui.add_space(theme::GAP / 2.0);
            }
            let view = state.accounts.get(&panel.id).cloned().unwrap_or_default();
            let shown = if view.account.is_empty() {
                &panel.account
            } else {
                &view.account
            };
            let response = ui.push_id(&panel.id, |ui| {
                if let Some(profile) = state.profiles.iter().find(|p| &p.id == shown) {
                    self.card(ui, state, profile, &view, chosen, panel);
                } else {
                    self.missing_panel(ui, panel, chosen);
                }
            });
            total = response.response.rect.bottom() - start;
            if index < 2 {
                first_two = total;
            }
        }
        (first_two, total)
    }
    fn title_bar(&mut self, ctx: &egui::Context, state: &Snapshot) -> f32 {
        let dark = self.settings.dark;
        egui::TopBottomPanel::top("window-header")
            .frame(
                egui::Frame::new()
                    .fill(theme::token("bg", dark))
                    .inner_margin(egui::Margin::symmetric(
                        theme::GAP as i8,
                        (theme::GAP / 4.0) as i8,
                    )),
            )
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    let control = theme::TITLE;
                    let drag_width =
                        (ui.available_width() - 5.0 * control - 5.0 * theme::GAP).max(0.0);
                    let (rect, _) =
                        ui.allocate_exact_size(Vec2::new(drag_width, control), Sense::hover());
                    self.drag_region = Some((rect, ui.layer_id()));
                    let mut title = egui::text::LayoutJob::default();
                    for (text, color) in [("token", "text"), ("Atlas", "accent")] {
                        title.append(
                            text,
                            0.0,
                            egui::TextFormat {
                                font_id: FontId::proportional(theme::SMALL),
                                color: theme::token(color, dark),
                                ..Default::default()
                            },
                        );
                    }
                    let galley = ui.painter().layout_job(title);
                    let icon_rect = Rect::from_center_size(
                        Pos2::new(rect.left() + control / 2.0, rect.center().y),
                        Vec2::splat(control),
                    );
                    ui.painter().image(
                        self.icon.id(),
                        icon_rect,
                        Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
                        Color32::WHITE,
                    );
                    ui.painter().galley(
                        Pos2::new(
                            icon_rect.right() + theme::GAP / 2.0,
                            rect.center().y - galley.size().y / 2.0,
                        ),
                        galley,
                        theme::token("text", dark),
                    );
                    if ui
                        .add_enabled(
                            !state.busy,
                            egui::Button::new("↻")
                                .frame(false)
                                .min_size(Vec2::splat(control)),
                        )
                        .on_hover_text("odśwież wspólne dane")
                        .clicked()
                    {
                        let _ = self.worker.tx.send(Command::Refresh);
                    }
                    if ui
                        .add_enabled(
                            self.settings.panels.len() < MAX_PANELS
                                && state
                                    .profiles
                                    .iter()
                                    .any(|p| self.settings.selected.contains(&p.id)),
                            egui::Button::new("+")
                                .frame(false)
                                .min_size(Vec2::splat(control)),
                        )
                        .on_hover_text("dodaj wykres")
                        .clicked()
                    {
                        self.add_panel(state);
                    }
                    if ui
                        .add_sized([control, control], egui::Button::new("···").frame(false))
                        .on_hover_text("ustawienia")
                        .clicked()
                    {
                        self.settings_open = true;
                    }
                    if ui
                        .add_sized([control, control], egui::Button::new("−").frame(false))
                        .on_hover_text("do zasobnika")
                        .clicked()
                    {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(true));
                    }
                    if ui
                        .add_sized([control, control], egui::Button::new("×").frame(false))
                        .on_hover_text("zamknij")
                        .clicked()
                    {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                });
            })
            .response
            .rect
            .height()
    }
    fn add_panel(&mut self, state: &Snapshot) {
        let chosen = state
            .profiles
            .iter()
            .filter(|p| self.settings.selected.contains(&p.id))
            .collect::<Vec<_>>();
        if let Some(profile) = chosen
            .iter()
            .copied()
            .find(|p| {
                !self
                    .settings
                    .panels
                    .iter()
                    .any(|panel| panel.account == p.id)
            })
            .or(chosen.first().copied())
        {
            let meter = state
                .accounts
                .values()
                .filter(|v| v.account == profile.id)
                .flat_map(|v| &v.meters)
                .find(|m| {
                    !self.settings.panels.iter().any(|p| {
                        p.account == profile.id
                            && p.meter.as_ref().or_else(|| {
                                state
                                    .accounts
                                    .get(&p.id)
                                    .and_then(|v| v.points.keys().next())
                            }) == Some(&m.key())
                    })
                })
                .map(Meter::key);
            self.settings
                .panels
                .push(PanelChoice::new(profile.id.clone(), meter));
            self.configure();
        }
    }
    fn missing_panel(&mut self, ui: &mut egui::Ui, panel: &PanelChoice, chosen: &[&Profile]) {
        ui.horizontal(|ui| {
            let mut account = panel.account.clone();
            egui::ComboBox::from_id_salt("account")
                .selected_text("abonament niedostępny")
                .show_ui(ui, |ui| {
                    for profile in chosen {
                        ui.selectable_value(
                            &mut account,
                            profile.id.clone(),
                            format!("{} · {}", profile.provider.name(), profile.label),
                        );
                    }
                });
            if account != panel.account
                && let Some(choice) = self.settings.panels.iter_mut().find(|p| p.id == panel.id)
            {
                choice.account = account;
                choice.meter = None;
                self.configure();
            }
            if ui.small_button("×").on_hover_text("usuń wykres").clicked() {
                self.settings.panels.retain(|p| p.id != panel.id);
                self.configure();
            }
        });
        ui.label(RichText::new("—").size(theme::FIGURE))
            .on_hover_text(&panel.account);
    }
    fn card(
        &mut self,
        ui: &mut egui::Ui,
        state: &Snapshot,
        profile: &Profile,
        view: &AccountView,
        chosen: &[&Profile],
        panel: &PanelChoice,
    ) {
        let dark = self.settings.dark;
        let accent = theme::token("accent", dark);
        let muted = theme::token("muted", dark);
        let body_start = ui.cursor().min.y;
        ui.horizontal(|ui| {
            let (dot, _) = ui.allocate_exact_size(Vec2::new(8.0, 16.0), Sense::hover());
            ui.painter().circle_filled(dot.center(), 3.0, accent);
            let mut active = panel.account.clone();
            egui::ComboBox::from_id_salt("account")
                .selected_text(
                    RichText::new(match profile.provider {
                        Provider::Codex => "OpenAI / Codex",
                        Provider::Claude => "Anthropic / Claude",
                    })
                    .strong(),
                )
                .width(132.0)
                .show_ui(ui, |ui| {
                    for p in chosen {
                        ui.selectable_value(
                            &mut active,
                            p.id.clone(),
                            format!("{} · {}", p.provider.name(), p.label),
                        );
                    }
                });
            if active != panel.account {
                if let Some(choice) = self.settings.panels.iter_mut().find(|p| p.id == panel.id) {
                    choice.account = active;
                    choice.meter = None;
                }
                self.configure();
            }
            if let Some(plan) = view.facts.plan.as_ref().or(profile.plan.as_ref()) {
                ui.label(RichText::new(plan).small().color(muted));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui
                    .add_enabled(
                        self.settings.panels.len() > 1,
                        egui::Button::new("×").small(),
                    )
                    .on_hover_text("usuń wykres")
                    .clicked()
                {
                    self.settings.panels.retain(|p| p.id != panel.id);
                    self.configure();
                }
                if self.options.demo {
                    ui.label(RichText::new("demo").small().color(muted));
                }
            });
        });
        ui.add(
            egui::Label::new(
                RichText::new(profile.email.as_deref().unwrap_or(&profile.label))
                    .small()
                    .color(muted),
            )
            .truncate(),
        )
        .on_hover_text(&profile.label);
        let mut selected = panel.meter.clone().unwrap_or_default();
        // Keep a shared snapshot's card and history on the same published window while switching.
        let meter_key = view.points.keys().next();
        let meter = crate::common::choose_meter(&view.meters, meter_key);
        let now = now_ms();
        let elapsed = meter.and_then(|m| elapsed(m, view.at?, view.bounds));
        let estimate = meter
            .map(|m| {
                Estimate::new(
                    m,
                    view.at,
                    view.rate_basis,
                    view.bounds,
                    now,
                    self.settings.interval_minutes,
                )
            })
            .unwrap_or_default();
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(
                    meter
                        .map(|m| format!("{}%", number(m.percent)))
                        .unwrap_or("—".into()),
                )
                .font(FontId::monospace(theme::FIGURE)),
            );
            ui.label(
                RichText::new(
                    elapsed
                        .map(|e| format!("zużyte · {:.0}% czasu", e * 100.0))
                        .unwrap_or_else(|| "zużyte".into()),
                )
                .small()
                .color(muted),
            )
            .on_hover_text("Czas w chwili ostatniego odczytu; granice okna pochodzą od dostawcy.");
            if let Some(pace) = estimate.multiplier {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(
                        RichText::new(format!("{pace:.2}×"))
                            .monospace()
                            .color(theme::token("warn", dark)),
                    )
                    .on_hover_text("Zużycie / część czasu okna; średnie tempo od jego początku.");
                });
            }
        });
        let (track, _) =
            ui.allocate_exact_size(Vec2::new(ui.available_width(), 4.0), Sense::hover());
        ui.painter()
            .rect_filled(track, 0, theme::token("line2", dark));
        if let Some(m) = meter {
            ui.painter().rect_filled(
                Rect::from_min_max(
                    track.min,
                    Pos2::new(
                        track.left() + track.width() * m.percent as f32 / 100.0,
                        track.bottom(),
                    ),
                ),
                0,
                accent,
            );
        }
        if let Some(e) = elapsed {
            let x = track.left() + track.width() * e as f32;
            ui.painter().line_segment(
                [Pos2::new(x, track.top()), Pos2::new(x, track.bottom())],
                Stroke::new(1.0_f32, theme::token("text", dark)),
            );
        }
        ui.horizontal(|ui| {
            egui::ComboBox::from_id_salt(("window", &profile.id))
                .width(70.0)
                .selected_text(meter.map(Meter::label).unwrap_or_else(|| "okno".into()))
                .show_ui(ui, |ui| {
                    for m in &view.meters {
                        ui.selectable_value(&mut selected, m.key(), m.label());
                    }
                });
            if let Some(reset) = view
                .bounds
                .map(|b| b.1)
                .or_else(|| meter.and_then(|m| m.resets_at))
            {
                ui.label(
                    RichText::new(if reset > now {
                        format!(
                            "{} {}",
                            if meter.and_then(|m| m.resets_at) == Some(reset) {
                                "reset"
                            } else {
                                "koniec"
                            },
                            duration(reset - now)
                        )
                    } else {
                        "okno zakończone".into()
                    })
                    .small()
                    .color(muted),
                )
                .on_hover_text(local_time(reset, "%d.%m.%Y %H:%M:%S"));
            } else {
                ui.label(RichText::new("reset —").small().color(muted));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let status = if state.busy {
                    "odczyt…".into()
                } else if view.error.is_some() {
                    "błąd odczytu".into()
                } else {
                    view.at
                        .map(|at| format!("{} min temu", (now - at).max(0) / 60_000))
                        .unwrap_or("—".into())
                };
                ui.label(
                    RichText::new(status)
                        .small()
                        .color(if view.error.is_some() {
                            theme::token("crit", dark)
                        } else {
                            muted
                        }),
                )
                .on_hover_text(view.error.clone().unwrap_or_else(|| {
                    view.origin.clone().unwrap_or_else(|| {
                        view.at
                            .map(|at| local_time(at, "%d.%m.%Y %H:%M:%S"))
                            .unwrap_or_default()
                    })
                }));
            });
        });
        if !selected.is_empty()
            && panel.meter.as_ref() != Some(&selected)
            && let Some(choice) = self
                .settings
                .panels
                .iter_mut()
                .find(|p| p.id == panel.id && p.account == profile.id)
        {
            choice.meter = Some(selected);
            self.configure();
        }
        let eta = if meter.is_some_and(|m| m.percent >= 100.0) {
            "osiągnięte".into()
        } else if let Some(at) = estimate.ceiling_at {
            if view
                .bounds
                .map(|b| b.1)
                .or_else(|| meter.and_then(|m| m.resets_at))
                .is_some_and(|reset| at >= reset)
            {
                "po oknie".into()
            } else if at <= now {
                "≈ teraz".into()
            } else {
                format!("≈ {}", duration(at - now))
            }
        } else {
            "—".into()
        };
        let rate_help = estimate
            .basis_at
            .map(|at| {
                format!(
                    "Średnie tempo od {} do ostatniego odczytu. Bez dopisywania pomiarów.",
                    local_time(at, "%d.%m.%Y %H:%M")
                )
            })
            .unwrap_or("Za mało zgodnych odczytów do wyznaczenia tempa.".into());
        let eta_help = estimate
            .ceiling_at
            .map(|at| {
                format!(
                    "Prognoza liniowa: {}. Obowiązuje do resetu i zakłada niezmienione tempo.",
                    local_time(at, "%d.%m.%Y %H:%M")
                )
            })
            .unwrap_or(
                "Prognoza wymaga świeżego odczytu, dodatniego tempa i trwającego okna.".into(),
            );
        let metrics = [
            (
                "pozostało",
                meter
                    .map(|_| format!("{}%", number(estimate.remaining_percent)))
                    .unwrap_or("—".into()),
                "Do limitu 100% wybranego licznika.".to_string(),
            ),
            (
                "tempo",
                estimate
                    .percent_per_hour
                    .map(|rate| format!("{rate:.2}%/h"))
                    .unwrap_or("—".into()),
                rate_help,
            ),
            ("do 100%", eta, eta_help),
        ];
        ui.columns(3, |columns| {
            for (column, (label, value, help)) in columns.iter_mut().zip(metrics) {
                column.label(RichText::new(label).small().color(muted));
                column
                    .label(RichText::new(value).monospace())
                    .on_hover_text(help);
            }
        });
        if view.facts.tokens.is_some() || view.facts.api_standard.is_some() {
            let facts_help = view
                .facts_at
                .map(|at| {
                    format!(
                    "Odczyt sum z opublikowanego rejestru: {}. Świeży procent nie przelicza tokenów.",
                        local_time(at, "%d.%m.%Y %H:%M:%S")
                    )
                })
                .unwrap_or_default();
            ui.horizontal(|ui| {
                if let Some(tokens) = view.facts.tokens {
                    ui.label(
                        RichText::new(format!("{} tokens", compact(tokens)))
                            .small()
                            .color(muted),
                    );
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if let Some(usd) = view.facts.api_standard {
                        ui.label(
                            RichText::new(format!(
                                "{}${usd:.2} API-eq",
                                if view.facts.unpriced_tokens.is_some_and(|n| n > 0.0) {
                                    "≥ "
                                } else {
                                    ""
                                }
                            ))
                            .small()
                            .color(muted),
                        );
                    }
                });
            })
            .response
            .on_hover_text(facts_help);
        }
        if view.facts.credits.is_some() || view.facts.free_resets.is_some() {
            ui.horizontal(|ui| {
                if let Some(credits) = &view.facts.credits {
                    ui.label(
                        RichText::new(format!("kredyty {credits}"))
                            .small()
                            .color(muted),
                    );
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if let Some(count) = view.facts.free_resets {
                        ui.label(
                            RichText::new(format!("darmowe resety {count}"))
                                .small()
                                .color(muted),
                        );
                    }
                });
            });
        }
        ui.add_space((body_start + theme::FIGURE * 5.5 - ui.cursor().min.y).max(0.0));
        if let Some(m) = meter {
            chart(ui, m, view, &estimate, dark);
        } else {
            ui.add_space(theme::FIGURE * 4.5);
        }
        ui.horizontal(|ui| {
            let (sample, _) = ui.allocate_exact_size(Vec2::new(16.0, 10.0), Sense::hover());
            ui.painter().hline(
                sample.x_range(),
                sample.center().y,
                Stroke::new(theme::CHART_STROKE, accent),
            );
            ui.label(RichText::new("zużycie").small().color(accent));
            let crit = theme::token("crit", dark);
            let (sample, _) = ui.allocate_exact_size(Vec2::new(16.0, 10.0), Sense::hover());
            dashed(
                ui.painter(),
                Pos2::new(sample.left(), sample.center().y),
                Pos2::new(sample.right(), sample.center().y),
                crit,
            );
            ui.label(RichText::new("tempo").small().color(crit));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label(RichText::new("tokenAtlas").small().color(muted));
            });
        });
    }
    fn settings_panel(&mut self, ctx: &egui::Context, state: &Snapshot) {
        let mut open = self.settings_open;
        egui::Window::new("ustawienia").open(&mut open).default_width(WIDTH-theme::GAP*4.0)
            .default_pos([theme::GAP,theme::TITLE+theme::GAP]).resizable(false).collapsible(false).show(ctx,|ui| {
                egui::ScrollArea::vertical().max_height(250.0).show(ui,|ui| {
                    let mut changed=false;
                    for profile in &state.profiles {
                        let mut selected=self.settings.selected.contains(&profile.id);
                        if ui.checkbox(&mut selected,&profile.label).changed() {
                            self.settings.selected.retain(|id|id!=&profile.id);
                            if selected {self.settings.selected.push(profile.id.clone());}
                            self.settings.panels.retain(|p|self.settings.selected.contains(&p.account));
                            self.settings.ensure_panels(&state.profiles);
                            changed=true;
                        }
                    }
                    if ui.small_button("wykryj konta").clicked() {let _=self.worker.tx.send(Command::Discover);}
                    ui.separator();
                    ui.horizontal(|ui| {
                        ui.label("pomiary co").on_hover_text("Gdy pełna aplikacja działa, mini odczytuje wspólną bazę co 5 sekund. Gdy jest zamknięta, ten interwał steruje kolektorem procentów.");
                        changed |= ui.add(egui::DragValue::new(&mut self.settings.interval_minutes).range(5..=120).suffix(" min")).changed();
                    });
                    if ui.checkbox(&mut self.settings.dark,"ciemny motyw").changed() {
                        theme::apply(ctx,self.settings.dark); changed=true;
                    }
                    if ui.checkbox(&mut self.settings.always_on_top,"zawsze na wierzchu").changed() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::WindowLevel(if self.settings.always_on_top {
                            egui::WindowLevel::AlwaysOnTop
                        }else{egui::WindowLevel::Normal})); changed=true;
                    }
                    ui.collapsing("instalacja tokenAtlas",|ui| {
                        ui.text_edit_singleline(&mut self.new_home);
                        if ui.small_button("dodaj").clicked() {
                            match crate::common::find_root(Some(&PathBuf::from(self.new_home.trim()))) {
                                Ok(root) => {self.settings.atlas_root=Some(root);self.new_home.clear(); self.local_error=None; changed=true;}
                                Err(e)=>self.local_error=Some(e.to_string()),
                            }
                        }
                    });
                    ui.label(RichText::new("dane lokalne ⓘ").small()).on_hover_text(self.root.display().to_string());
                    ui.label(RichText::new("wspólne dane ⓘ").small()).on_hover_text("Gotowe okna, historia i sumy z bazy wybranej w Settings tokenAtlas. Monitor czyta ją bez zapisu i bez przebudowy.");
                    if changed {self.configure();}
                });
            });
        self.settings_open = open;
    }
}

fn elapsed(meter: &Meter, at: i64, bounds: Option<(i64, i64)>) -> Option<f64> {
    let (start, end) =
        bounds.or_else(|| Some((meter.resets_at? - meter.minutes? * 60_000, meter.resets_at?)))?;
    let span = end - start;
    (span > 0 && at >= start && at <= start + span).then(|| (at - start) as f64 / span as f64)
}
fn compact(n: f64) -> String {
    if n >= 1_000_000_000.0 {
        format!("{:.2}B", n / 1_000_000_000.0)
    } else if n >= 1_000_000.0 {
        format!("{:.1}M", n / 1_000_000.0)
    } else if n >= 1000.0 {
        format!("{:.1}k", n / 1000.0)
    } else {
        format!("{n:.0}")
    }
}
fn number(n: f64) -> String {
    if n.fract().abs() < 0.05 {
        format!("{n:.0}")
    } else {
        format!("{n:.1}")
    }
}
fn duration(ms: i64) -> String {
    let m = (ms / 60_000).max(0);
    if m >= 1440 {
        format!("{} d {} h", m / 1440, m % 1440 / 60)
    } else if m >= 60 {
        format!("{} h {} min", m / 60, m % 60)
    } else {
        format!("{m} min")
    }
}
fn local_time(ms: i64, format: &str) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.with_timezone(&chrono::Local).format(format).to_string())
        .unwrap_or("—".into())
}

fn chart(ui: &mut egui::Ui, meter: &Meter, view: &AccountView, estimate: &Estimate, dark: bool) {
    let (rect, response) = ui.allocate_exact_size(
        Vec2::new(ui.available_width(), theme::FIGURE * 4.5),
        Sense::hover(),
    );
    let plot = Rect::from_min_max(
        rect.min + egui::vec2(32.0, 18.0),
        rect.max - egui::vec2(8.0, 26.0),
    );
    let painter = ui.painter();
    let ink = theme::token("text", dark);
    let muted = theme::token("muted", dark);
    let accent = theme::token("accent", dark);
    let line = theme::token("line", dark);
    let points = view
        .points
        .get(&meter.key())
        .map(Vec::as_slice)
        .unwrap_or_default();
    let at = view.at.unwrap_or_else(now_ms);
    let end = view.bounds.map(|b| b.1).unwrap_or_else(|| {
        meter
            .resets_at
            .filter(|r| *r > at)
            .unwrap_or(at + 60 * 60_000)
    });
    let start = view.bounds.map(|b| b.0).unwrap_or_else(|| {
        meter
            .minutes
            .zip(meter.resets_at)
            .map(|(m, r)| r - m * 60_000)
            .unwrap_or_else(|| points.first().map(|p| p.at).unwrap_or(at - 60 * 60_000))
            .min(at - 60_000)
    });
    let xy = |t: f64, p: f64| {
        Pos2::new(
            plot.left() + ((t - start as f64) / (end - start) as f64) as f32 * plot.width(),
            plot.bottom() - p as f32 / 100.0 * plot.height(),
        )
    };
    let font = FontId::monospace(theme::CHART);
    for value in [0.0, 50.0, 100.0] {
        let y = xy(start as f64, value).y;
        if value == 50.0 {
            dashed(
                painter,
                Pos2::new(plot.left(), y),
                Pos2::new(plot.right(), y),
                line,
            );
        } else {
            painter.hline(plot.x_range(), y, Stroke::new(1.0_f32, line));
        }
        painter.text(
            Pos2::new(plot.left() - 6.0, y),
            Align2::RIGHT_CENTER,
            format!("{value:.0}%"),
            font.clone(),
            muted,
        );
    }
    let groups = segments_in(points, meter, view.bounds);
    for group in groups {
        let vertices: Vec<_> = group.iter().map(|p| xy(p[0] * 1000.0, p[1])).collect();
        // Shared mesh edges avoid vertical antialias seams in the area fill.
        let mut fill = egui::epaint::Mesh::default();
        for vertex in &vertices {
            fill.colored_vertex(*vertex, accent.gamma_multiply(0.12));
            fill.colored_vertex(
                Pos2::new(vertex.x, plot.bottom()),
                accent.gamma_multiply(0.12),
            );
        }
        for index in 0..vertices.len().saturating_sub(1) {
            let i = index as u32 * 2;
            fill.add_triangle(i, i + 1, i + 2);
            fill.add_triangle(i + 1, i + 3, i + 2);
        }
        painter.add(egui::Shape::mesh(fill));
        if vertices.len() > 1 {
            painter.add(egui::Shape::line(
                vertices.clone(),
                Stroke::new(theme::CHART_STROKE, accent),
            ));
        }
        for p in vertices.iter().filter(|_| vertices.len() == 1) {
            painter.circle_filled(*p, 2.0, accent);
        }
    }
    painter.vline(plot.right(), plot.y_range(), Stroke::new(1.0_f32, line));
    let now = now_ms();
    if now >= start && now <= end {
        let a = xy(now as f64, 0.0);
        let b = xy(now as f64, 100.0);
        dashed(painter, a, b, muted);
        painter.text(
            Pos2::new(a.x, plot.top() - 8.0),
            Align2::CENTER_CENTER,
            "teraz",
            font.clone(),
            muted,
        );
    }
    let latest = xy(at as f64, meter.percent);
    if at >= start && at <= end {
        painter.circle_filled(latest, 3.5, accent);
        painter.text(
            latest + egui::vec2(7.0, 8.0),
            Align2::LEFT_CENTER,
            format!("{}%", number(meter.percent)),
            font.clone(),
            ink,
        );
    }
    if end > now
        && let (Some(ceiling), Some(rate)) = (estimate.ceiling_at, estimate.percent_per_hour)
    {
        let target = ceiling.min(end).max(at);
        dashed(
            painter,
            latest,
            xy(
                target as f64,
                (meter.percent + (target - at) as f64 * rate / 3_600_000.0).min(100.0),
            ),
            theme::token("crit", dark),
        );
    }
    let format = if end - start > 86_400_000 {
        "%d.%m"
    } else {
        "%H:%M"
    };
    for (t, align) in [
        (start, Align2::LEFT_TOP),
        ((start + end) / 2, Align2::CENTER_TOP),
        (end, Align2::RIGHT_TOP),
    ] {
        painter.text(
            Pos2::new(xy(t as f64, 0.0).x, plot.bottom() + 8.0),
            align,
            local_time(t, format),
            font.clone(),
            muted,
        );
    }
    if let Some(pos) = response.hover_pos().filter(|pos| plot.contains(*pos)) {
        let timestamp =
            start + ((pos.x - plot.left()) / plot.width() * (end - start) as f32) as i64;
        if let Some(p) = points
            .iter()
            .filter(|p| p.reset == meter.resets_at && p.at >= start && p.at <= end)
            .min_by_key(|p| (p.at - timestamp).abs())
        {
            response.on_hover_text(format!(
                "{} · {}%",
                local_time(p.at, "%d.%m.%Y %H:%M"),
                number(p.percent)
            ));
        }
    }
}
fn dashed(painter: &egui::Painter, a: Pos2, b: Pos2, color: Color32) {
    let delta = b - a;
    let length = delta.length();
    if length <= 0.0 {
        return;
    }
    let unit = delta / length;
    let mut offset = 0.0;
    while offset < length {
        painter.line_segment(
            [a + unit * offset, a + unit * (offset + 4.0).min(length)],
            Stroke::new(1.0_f32, color),
        );
        offset += 7.0;
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    #[test]
    fn two_complete_cards_fit_their_measured_height_and_stabilize() {
        let dir = tempfile::tempdir().unwrap();
        let options = Options {
            demo: true,
            ..Default::default()
        };
        let prepared = Prepared::new(Store::open(dir.path()).unwrap(), options).unwrap();
        let ctx = egui::Context::default();
        let mut monitor = Monitor::new(&ctx, prepared);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !monitor.ready() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(monitor.ready());
        {
            let mut state = monitor.worker.snapshot.lock().unwrap();
            for view in state.accounts.values_mut() {
                view.facts.tokens = Some(7_820_000_000.0);
                view.facts.api_standard = Some(2_575.68);
                view.facts.credits = Some("58.860".into());
                view.facts.free_resets = Some(2);
                view.facts.plan = Some("pro · ×20 · długi wariant abonamentu".into());
            }
        }
        let mut sizes = Vec::new();
        for frame in 0..6 {
            let size = monitor.window_size();
            let _ = ctx.run(
                egui::RawInput {
                    screen_rect: Some(Rect::from_min_size(Pos2::ZERO, size)),
                    time: Some(frame as f64 / 60.0),
                    ..Default::default()
                },
                |ctx| monitor.render(ctx),
            );
            sizes.push(monitor.window_size().y);
        }
        assert!(monitor.window_size().y > window_size(2).y);
        assert!(monitor.content_height < monitor.window_size().y);
        assert_eq!(&sizes[3..], &[sizes[3]; 3]);
        monitor.set_max_height(500.0);
        let _ = ctx.run(
            egui::RawInput {
                screen_rect: Some(Rect::from_min_size(Pos2::ZERO, monitor.window_size())),
                ..Default::default()
            },
            |ctx| monitor.render(ctx),
        );
        assert_eq!(monitor.window_size().y, 500.0);
        assert!(monitor.content_height > 500.0);
        monitor.set_max_height(1000.0);
        for _ in 0..2 {
            let _ = ctx.run(
                egui::RawInput {
                    screen_rect: Some(Rect::from_min_size(Pos2::ZERO, monitor.window_size())),
                    ..Default::default()
                },
                |ctx| monitor.render(ctx),
            );
        }
        assert_eq!(monitor.window_size().y, sizes[3]);
    }
}
