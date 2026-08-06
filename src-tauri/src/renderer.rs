use glam::Mat4;
use wgpu::util::DeviceExt;

use crate::protocol::ViewportRect;

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct Vertex {
    position: [f32; 3],
    color: [f32; 3],
}

impl Vertex {
    const ATTRIBS: [wgpu::VertexAttribute; 2] =
        wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3];

    fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBS,
        }
    }
}

/// 24 vertices (4 per face) so each face can have its own flat color.
#[rustfmt::skip]
const VERTICES: &[Vertex] = &[
    // +X face (red)
    Vertex { position: [ 0.5, -0.5, -0.5], color: [1.0, 0.2, 0.2] },
    Vertex { position: [ 0.5,  0.5, -0.5], color: [1.0, 0.2, 0.2] },
    Vertex { position: [ 0.5,  0.5,  0.5], color: [1.0, 0.2, 0.2] },
    Vertex { position: [ 0.5, -0.5,  0.5], color: [1.0, 0.2, 0.2] },
    // -X face (cyan)
    Vertex { position: [-0.5, -0.5,  0.5], color: [0.2, 1.0, 1.0] },
    Vertex { position: [-0.5,  0.5,  0.5], color: [0.2, 1.0, 1.0] },
    Vertex { position: [-0.5,  0.5, -0.5], color: [0.2, 1.0, 1.0] },
    Vertex { position: [-0.5, -0.5, -0.5], color: [0.2, 1.0, 1.0] },
    // +Y face (green)
    Vertex { position: [-0.5,  0.5, -0.5], color: [0.2, 1.0, 0.2] },
    Vertex { position: [-0.5,  0.5,  0.5], color: [0.2, 1.0, 0.2] },
    Vertex { position: [ 0.5,  0.5,  0.5], color: [0.2, 1.0, 0.2] },
    Vertex { position: [ 0.5,  0.5, -0.5], color: [0.2, 1.0, 0.2] },
    // -Y face (magenta)
    Vertex { position: [-0.5, -0.5,  0.5], color: [1.0, 0.2, 1.0] },
    Vertex { position: [-0.5, -0.5, -0.5], color: [1.0, 0.2, 1.0] },
    Vertex { position: [ 0.5, -0.5, -0.5], color: [1.0, 0.2, 1.0] },
    Vertex { position: [ 0.5, -0.5,  0.5], color: [1.0, 0.2, 1.0] },
    // +Z face (blue)
    Vertex { position: [-0.5, -0.5,  0.5], color: [0.3, 0.4, 1.0] },
    Vertex { position: [ 0.5, -0.5,  0.5], color: [0.3, 0.4, 1.0] },
    Vertex { position: [ 0.5,  0.5,  0.5], color: [0.3, 0.4, 1.0] },
    Vertex { position: [-0.5,  0.5,  0.5], color: [0.3, 0.4, 1.0] },
    // -Z face (yellow)
    Vertex { position: [ 0.5, -0.5, -0.5], color: [1.0, 1.0, 0.2] },
    Vertex { position: [-0.5, -0.5, -0.5], color: [1.0, 1.0, 0.2] },
    Vertex { position: [-0.5,  0.5, -0.5], color: [1.0, 1.0, 0.2] },
    Vertex { position: [ 0.5,  0.5, -0.5], color: [1.0, 1.0, 0.2] },
];

#[rustfmt::skip]
const INDICES: &[u16] = &[
    0, 1, 2,  0, 2, 3,       // +X
    4, 5, 6,  4, 6, 7,       // -X
    8, 9, 10, 8, 10, 11,     // +Y
    12, 13, 14, 12, 14, 15,  // -Y
    16, 17, 18, 16, 18, 19,  // +Z
    20, 21, 22, 20, 22, 23,  // -Z
];

const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;

/// Everything needed to render the rotating cube into the native wgpu
/// surface that sits behind the (transparent) Tauri WebView.
pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    depth_view: wgpu::TextureView,
    pipeline: wgpu::RenderPipeline,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    num_indices: u32,
    uniform_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    /// Last-requested viewport rectangle, in physical pixels. Not
    /// necessarily within the current surface bounds yet (e.g. a resize may
    /// have happened since the last `set_viewport` call) — always re-clamped
    /// against the live surface size in `render()`.
    viewport_px: (f32, f32, f32, f32),
    /// View-projection matrix supplied by the camera (see `camera.rs`).
    /// The renderer knows nothing about cameras or input — it just applies
    /// whatever matrix it's given each frame.
    view_proj: Mat4,
}

impl Renderer {
    /// Creates the wgpu instance/surface/adapter/device/queue synchronously
    /// (via `pollster::block_on`) and builds the render pipeline for the cube.
    pub fn new(window: tauri::WebviewWindow, size: (u32, u32)) -> Renderer {
        let (width, height) = (size.0.max(1), size.1.max(1));

        let instance = wgpu::Instance::default();

        // WebviewWindow implements HasWindowHandle + HasDisplayHandle, so it
        // can be turned into a `SurfaceTarget` directly (owned, 'static).
        let surface = instance
            .create_surface(window)
            .expect("failed to create wgpu surface from the Tauri window");

        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::default(),
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
            ..Default::default()
        }))
        .expect("failed to find an appropriate wgpu adapter");

        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("tauri3d device"),
            required_limits: wgpu::Limits::default(),
            ..Default::default()
        }))
        .expect("failed to create wgpu device");

        let surface_caps = surface.get_capabilities(&adapter);
        let format = surface_caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(surface_caps.formats[0]);
        let alpha_mode = surface_caps.alpha_modes[0];

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode,
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let depth_view = create_depth_view(&device, width, height);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("cube shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniform buffer"),
            size: std::mem::size_of::<Mat4>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("uniform bind group layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("uniform bind group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("cube pipeline layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("cube pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Some(Vertex::layout())],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: Some(wgpu::Face::Back),
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("vertex buffer"),
            contents: bytemuck::cast_slice(VERTICES),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("index buffer"),
            contents: bytemuck::cast_slice(INDICES),
            usage: wgpu::BufferUsages::INDEX,
        });

        Renderer {
            surface,
            device,
            queue,
            config,
            depth_view,
            pipeline,
            vertex_buffer,
            index_buffer,
            num_indices: INDICES.len() as u32,
            uniform_buffer,
            bind_group,
            viewport_px: (0.0, 0.0, width as f32, height as f32),
            view_proj: Mat4::IDENTITY,
        }
    }

    /// Reconfigures the surface (and depth buffer) for a new physical size.
    /// Guards against zero-sized surfaces (e.g. a minimized window).
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        self.depth_view = create_depth_view(&self.device, width, height);
    }

    /// Records the region of the surface (in physical pixels) that the cube
    /// should be drawn into. Actual clamping against the live surface bounds
    /// happens in `render()`, since the surface may be resized later without
    /// a fresh call to this setter.
    pub fn set_viewport(&mut self, x: f32, y: f32, width: f32, height: f32) {
        self.viewport_px = (x, y, width, height);
    }

    /// Aspect ratio (width / height) of the currently active viewport rect,
    /// clamped to the live surface bounds. Used by the caller to build the
    /// camera's projection matrix for the region the cube actually renders
    /// into (not the full window).
    pub fn viewport_aspect(&self) -> f32 {
        let (_, _, w, h) = self.clamped_viewport();
        if h > 0.0 {
            w / h
        } else {
            1.0
        }
    }

    /// Sets the view-projection matrix used for the next `render()` call.
    /// The renderer has no notion of cameras or input — this is its entire
    /// contract with whatever drives the camera (see `camera.rs`).
    pub fn set_view_proj(&mut self, view_proj: Mat4) {
        self.view_proj = view_proj;
    }

    /// Clamps a requested viewport rect to the current surface bounds so it
    /// can never produce an out-of-bounds scissor rect (which wgpu panics
    /// on).
    fn clamped_viewport(&self) -> (f32, f32, f32, f32) {
        let surf_w = self.config.width as f32;
        let surf_h = self.config.height as f32;
        let (x, y, width, height) = self.viewport_px;

        let x = x.clamp(0.0, surf_w);
        let y = y.clamp(0.0, surf_h);
        let width = width.max(0.0).min(surf_w - x);
        let height = height.max(0.0).min(surf_h - y);

        (x, y, width, height)
    }

    pub fn render(&mut self) {
        if self.config.width == 0 || self.config.height == 0 {
            return;
        }

        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) => frame,
            wgpu::CurrentSurfaceTexture::Suboptimal(frame) => {
                // Still presentable this frame; reconfigure before the next one.
                self.surface.configure(&self.device, &self.config);
                frame
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return;
            }
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                eprintln!("wgpu surface validation error while acquiring frame");
                return;
            }
        };

        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // The cube itself is static (no model transform); the camera-supplied
        // view-projection matrix is the whole uniform.
        self.queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::cast_slice(&[self.view_proj]),
        );

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame encoder"),
            });

        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("cube pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // Full-surface clear with an opaque dark color; the
                        // cube only shows up wherever the WebView above it
                        // is transparent (the ViewportHost region).
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.07,
                            g: 0.07,
                            b: 0.09,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });

            let (x, y, w, h) = self.clamped_viewport();
            if w > 0.0 && h > 0.0 {
                rpass.set_viewport(x, y, w, h, 0.0, 1.0);
                rpass.set_scissor_rect(x as u32, y as u32, w as u32, h as u32);

                rpass.set_pipeline(&self.pipeline);
                rpass.set_bind_group(0, &self.bind_group, &[]);
                rpass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
                rpass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
                rpass.draw_indexed(0..self.num_indices, 0, 0..1);
            }
        }

        self.queue.submit(Some(encoder.finish()));
        self.queue.present(frame);
    }
}

fn create_depth_view(device: &wgpu::Device, width: u32, height: u32) -> wgpu::TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("depth texture"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: DEPTH_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}

/// Converts a CSS-pixel `ViewportRect` (as sent from the frontend) into the
/// physical-pixel viewport applied to the renderer.
pub fn apply_viewport_rect(renderer: &mut Renderer, rect: ViewportRect) {
    let scale = rect.scale_factor;
    renderer.set_viewport(
        rect.x * scale,
        rect.y * scale,
        rect.width * scale,
        rect.height * scale,
    );
}
