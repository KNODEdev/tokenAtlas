use std::{env, fs, path::PathBuf};

fn main() {
    let css_path = "../../src/web/components/ui.css";
    println!("cargo:rerun-if-changed={css_path}");
    let css = fs::read_to_string(css_path).expect("shared UI scale");
    let mut generated = String::new();
    for (name, token, kind) in [
        ("BODY", "fs-4", "f32"),
        ("SMALL", "fs-2", "f32"),
        ("CHART", "fs-1", "f32"),
        ("FIGURE", "fs-8", "f32"),
        ("TITLE", "fs-7", "f32"),
        ("GAP", "s-4", "f32"),
        ("CONTROL_RADIUS", "r-control", "u8"),
    ] {
        let marker = format!("--{token}:");
        let value = css
            .split(&marker)
            .nth(1)
            .expect("shared size token")
            .trim_start()
            .split("px")
            .next()
            .unwrap();
        let number: f32 = value.parse().expect("numeric size token");
        generated.push_str(&format!(
            "pub const {name}:{kind}={number}{suffix};\n",
            suffix = if kind == "f32" { "_f32" } else { "" }
        ));
    }
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("theme-scale.rs"),
        generated,
    )
    .unwrap();
    println!("cargo:rerun-if-changed=assets/tokenatlas-monitor.ico");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        winresource::WindowsResource::new()
            .set_icon("assets/tokenatlas-monitor.ico")
            .set("ProductName", "tokenAtlas Monitor")
            .set("FileDescription", "tokenAtlas Monitor")
            .compile()
            .expect("compile application icon resources");
    }
}
