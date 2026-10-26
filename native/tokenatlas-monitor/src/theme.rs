use egui::{self, Color32, FontData, FontDefinitions, FontFamily, FontId, Stroke, TextStyle};

// Native projection of the existing CSS vocabulary; the CSS remains the source of truth.
const COLORS: &str = include_str!("../../../src/web/tokens.css");
include!(concat!(env!("OUT_DIR"), "/theme-scale.rs"));
pub const CHART_STROKE: f32 = 1.75;

pub fn token(name: &str, dark: bool) -> Color32 {
    let section = if dark {
        COLORS.split("[data-theme=\"light\"]").next().unwrap()
    } else {
        COLORS
            .split("[data-theme=\"light\"]")
            .nth(1)
            .expect("light tokens")
    };
    let marker = format!("--{name}: #");
    let value = section
        .split(&marker)
        .nth(1)
        .expect("shared palette token")
        .get(..6)
        .unwrap();
    Color32::from_rgb(
        u8::from_str_radix(&value[0..2], 16).unwrap(),
        u8::from_str_radix(&value[2..4], 16).unwrap(),
        u8::from_str_radix(&value[4..6], 16).unwrap(),
    )
}
pub fn install(ctx: &egui::Context, dark: bool) {
    let mut fonts = FontDefinitions::default();
    fonts.font_data.insert(
        "plex".into(),
        FontData::from_static(include_bytes!(
            "../../../scripts/usage-monitor-assets/ibm-plex-sans.ttf"
        ))
        .into(),
    );
    fonts
        .families
        .entry(FontFamily::Proportional)
        .or_default()
        .insert(0, "plex".into());
    fonts.font_data.insert(
        "plex-mono".into(),
        FontData::from_static(include_bytes!("../assets/IBMPlexMono-Regular.ttf")).into(),
    );
    fonts
        .families
        .entry(FontFamily::Monospace)
        .or_default()
        .insert(0, "plex-mono".into());
    ctx.set_fonts(fonts);
    apply(ctx, dark);
}
pub fn apply(ctx: &egui::Context, dark: bool) {
    let theme = if dark {
        egui::Theme::Dark
    } else {
        egui::Theme::Light
    };
    ctx.set_theme(theme);
    let mut visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };
    visuals.override_text_color = Some(token("text", dark));
    visuals.panel_fill = token("bg", dark);
    visuals.window_fill = token("surface", dark);
    visuals.extreme_bg_color = token("sunk", dark);
    visuals.faint_bg_color = token("band", dark);
    visuals.selection.bg_fill = token("accent-soft", dark);
    visuals.selection.stroke = Stroke::new(1.0_f32, token("accent", dark));
    visuals.window_shadow = egui::epaint::Shadow::NONE;
    visuals.popup_shadow = egui::epaint::Shadow::NONE;
    for widget in [
        &mut visuals.widgets.noninteractive,
        &mut visuals.widgets.inactive,
        &mut visuals.widgets.hovered,
        &mut visuals.widgets.active,
        &mut visuals.widgets.open,
    ] {
        widget.bg_fill = token("surface", dark);
        widget.weak_bg_fill = token("raised", dark);
        widget.bg_stroke = Stroke::new(1.0_f32, token("line2", dark));
        widget.fg_stroke = Stroke::new(1.0_f32, token("text", dark));
        widget.corner_radius = egui::CornerRadius::same(CONTROL_RADIUS);
    }
    ctx.set_visuals_of(theme, visuals);
    ctx.style_mut(|s| {
        s.spacing.item_spacing = egui::vec2(GAP, GAP / 4.0);
        s.spacing.button_padding = egui::vec2(GAP, GAP / 4.0);
        s.text_styles
            .insert(TextStyle::Body, FontId::proportional(BODY));
        s.text_styles
            .insert(TextStyle::Button, FontId::proportional(BODY));
        s.text_styles
            .insert(TextStyle::Small, FontId::proportional(SMALL));
        s.text_styles
            .insert(TextStyle::Heading, FontId::proportional(TITLE));
        s.text_styles
            .insert(TextStyle::Monospace, FontId::monospace(BODY));
        s.animation_time = 0.0;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn system_theme_cannot_replace_the_selected_palette_on_first_frame() {
        for dark in [true, false] {
            let ctx = egui::Context::default();
            apply(&ctx, dark);
            let input = egui::RawInput {
                system_theme: Some(if dark {
                    egui::Theme::Light
                } else {
                    egui::Theme::Dark
                }),
                ..Default::default()
            };
            let _ = ctx.run(input, |ctx| {
                assert_eq!(
                    ctx.style().visuals.override_text_color,
                    Some(token("text", dark))
                );
            });
        }
    }
}
