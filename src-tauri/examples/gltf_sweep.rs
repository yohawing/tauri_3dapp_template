use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    path: String,
    status: String,
    elapsed_ms: u128,
    error: Option<String>,
    scenes: usize,
    nodes: usize,
    meshes: usize,
    primitives: usize,
    non_triangle_primitives: usize,
    materials: usize,
    textures: usize,
    images: usize,
    animations: usize,
    skins: usize,
    morph_targets: usize,
    buffer_bytes: usize,
    image_bytes: usize,
    extensions_used: Vec<String>,
    extensions_required: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SweepReport {
    root: String,
    total: usize,
    passed: usize,
    failed: usize,
    panicked: usize,
    elapsed_ms: u128,
    extensions_used: BTreeMap<String, usize>,
    results: Vec<ProbeResult>,
}

fn collect_assets(path: &Path, output: &mut Vec<PathBuf>) {
    if path.is_file() {
        output.push(path.to_owned());
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let excluded = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| matches!(name, ".git" | "node_modules" | "target" | "dist"));
            if !excluded {
                collect_assets(&path, output);
            }
        } else if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("gltf") || extension.eq_ignore_ascii_case("glb")
            })
        {
            output.push(path);
        }
    }
}

fn empty_result(path: &Path, status: &str, elapsed_ms: u128, error: String) -> ProbeResult {
    ProbeResult {
        path: path.display().to_string(),
        status: status.to_owned(),
        elapsed_ms,
        error: Some(error),
        scenes: 0,
        nodes: 0,
        meshes: 0,
        primitives: 0,
        non_triangle_primitives: 0,
        materials: 0,
        textures: 0,
        images: 0,
        animations: 0,
        skins: 0,
        morph_targets: 0,
        buffer_bytes: 0,
        image_bytes: 0,
        extensions_used: Vec::new(),
        extensions_required: Vec::new(),
    }
}

fn probe(path: &Path) -> ProbeResult {
    let started = Instant::now();
    match catch_unwind(AssertUnwindSafe(|| gltf::import(path))) {
        Ok(Ok((document, buffers, images))) => {
            let primitives: Vec<_> = document
                .meshes()
                .flat_map(|mesh| mesh.primitives())
                .collect();
            ProbeResult {
                path: path.display().to_string(),
                status: "pass".to_owned(),
                elapsed_ms: started.elapsed().as_millis(),
                error: None,
                scenes: document.scenes().count(),
                nodes: document.nodes().count(),
                meshes: document.meshes().count(),
                primitives: primitives.len(),
                non_triangle_primitives: primitives
                    .iter()
                    .filter(|primitive| primitive.mode() != gltf::mesh::Mode::Triangles)
                    .count(),
                materials: document.materials().count(),
                textures: document.textures().count(),
                images: document.images().count(),
                animations: document.animations().count(),
                skins: document.skins().count(),
                morph_targets: primitives
                    .iter()
                    .map(|primitive| primitive.morph_targets().count())
                    .sum(),
                buffer_bytes: buffers.iter().map(|buffer| buffer.0.len()).sum(),
                image_bytes: images.iter().map(|image| image.pixels.len()).sum(),
                extensions_used: document.extensions_used().map(str::to_owned).collect(),
                extensions_required: document.extensions_required().map(str::to_owned).collect(),
            }
        }
        Ok(Err(error)) => empty_result(
            path,
            "fail",
            started.elapsed().as_millis(),
            error.to_string(),
        ),
        Err(payload) => {
            let message = payload
                .downcast_ref::<&str>()
                .map(|message| (*message).to_owned())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic payload".to_owned());
            empty_result(path, "panic", started.elapsed().as_millis(), message)
        }
    }
}

fn probe_isolated(path: &Path, report_path: &Path, timeout: Duration) -> ProbeResult {
    let started = Instant::now();
    let executable = env::current_exe().expect("failed to resolve probe executable");
    let _ = fs::remove_file(report_path);
    let mut child = match Command::new(executable)
        .arg(path)
        .arg(report_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return empty_result(path, "spawn-fail", 0, error.to_string()),
    };

    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return fs::read(report_path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<SweepReport>(&bytes).ok())
                    .and_then(|mut report| report.results.pop())
                    .unwrap_or_else(|| {
                        empty_result(
                            path,
                            "report-fail",
                            started.elapsed().as_millis(),
                            "child completed without a readable result".to_owned(),
                        )
                    });
            }
            Ok(Some(status)) => {
                return empty_result(
                    path,
                    "process-fail",
                    started.elapsed().as_millis(),
                    format!("child exited with {status}"),
                );
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return empty_result(
                    path,
                    "timeout",
                    started.elapsed().as_millis(),
                    format!("probe exceeded {} seconds", timeout.as_secs()),
                );
            }
            Err(error) => {
                let _ = child.kill();
                return empty_result(
                    path,
                    "wait-fail",
                    started.elapsed().as_millis(),
                    error.to_string(),
                );
            }
        }
    }
}

fn main() {
    let mut args = env::args_os().skip(1);
    let root = PathBuf::from(args.next().expect("usage: gltf_sweep <root> <output.json>"));
    let output = PathBuf::from(args.next().expect("usage: gltf_sweep <root> <output.json>"));
    let started = Instant::now();
    let mut assets = Vec::new();
    collect_assets(&root, &mut assets);
    assets.sort();

    let results: Vec<_> = if root.is_file() {
        assets.iter().map(|path| probe(path)).collect()
    } else {
        let parts_dir = output
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("parts");
        fs::create_dir_all(&parts_dir).expect("failed to create partial report directory");
        let timeout = Duration::from_secs(
            env::var("TAURI3D_GLTF_PROBE_TIMEOUT_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(20),
        );
        assets
            .iter()
            .enumerate()
            .map(|(index, path)| {
                let result =
                    probe_isolated(path, &parts_dir.join(format!("{index:04}.json")), timeout);
                eprintln!(
                    "[{}/{}] {} {} ({}ms)",
                    index + 1,
                    assets.len(),
                    result.status,
                    path.display(),
                    result.elapsed_ms
                );
                result
            })
            .collect()
    };
    let mut extensions_used = BTreeMap::new();
    for extension in results.iter().flat_map(|result| &result.extensions_used) {
        *extensions_used.entry(extension.clone()).or_insert(0) += 1;
    }
    let report = SweepReport {
        root: root.display().to_string(),
        total: results.len(),
        passed: results
            .iter()
            .filter(|result| result.status == "pass")
            .count(),
        failed: results
            .iter()
            .filter(|result| result.status != "pass" && result.status != "panic")
            .count(),
        panicked: results
            .iter()
            .filter(|result| result.status == "panic")
            .count(),
        elapsed_ms: started.elapsed().as_millis(),
        extensions_used,
        results,
    };

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).expect("failed to create report directory");
    }
    fs::write(&output, serde_json::to_vec_pretty(&report).unwrap())
        .expect("failed to write report");
    println!(
        "gltf sweep: total={} pass={} fail={} panic={} elapsed={}ms report={}",
        report.total,
        report.passed,
        report.failed,
        report.panicked,
        report.elapsed_ms,
        output.display()
    );
}
