//! Clipboard utilities backed by arboard.
//!
//! # Overview
//! Provides text copy and image read support across Linux, macOS, and Windows
//! without shelling out to platform-specific commands.
//!
//! # Example
//! ```ignore
//! use arcane_natives::clipboard::copy_to_clipboard;
//!
//! # async fn demo() -> napi::Result<()> {
//! copy_to_clipboard("hello".to_string()).await?;
//! # Ok(())
//! # }
//! ```

#[cfg(not(target_os = "macos"))]
use std::io::Cursor;

#[cfg(not(target_os = "macos"))]
use arboard::ImageData;
use arboard::{Clipboard, Error as ClipboardError};
#[cfg(not(target_os = "macos"))]
use image::{DynamicImage, ImageFormat, RgbaImage};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Clipboard image payload encoded as PNG bytes.
#[napi(object)]
pub struct ClipboardImage {
	/// PNG-encoded image bytes.
	pub data:      Uint8Array,
	#[napi(js_name = "mimeType")]
	/// MIME type for the encoded image payload.
	pub mime_type: String,
}

#[cfg(not(target_os = "macos"))]
fn encode_png(image: ImageData<'_>) -> Result<Vec<u8>> {
	let width = u32::try_from(image.width)
		.map_err(|_| Error::from_reason("Clipboard image width overflow"))?;
	let height = u32::try_from(image.height)
		.map_err(|_| Error::from_reason("Clipboard image height overflow"))?;
	let bytes = image.bytes.into_owned();
	let buffer = RgbaImage::from_raw(width, height, bytes)
		.ok_or_else(|| Error::from_reason("Clipboard image buffer size mismatch"))?;
	let capacity = width.saturating_mul(height).saturating_mul(4) as usize;
	let mut output = Vec::with_capacity(capacity);
	DynamicImage::ImageRgba8(buffer)
		.write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
		.map_err(|err| Error::from_reason(format!("Failed to encode clipboard image: {err}")))?;
	Ok(output)
}

/// Copy plain text to the system clipboard.
///
/// # Parameters
/// - `text`: UTF-8 text to place on the clipboard.
///
/// # Errors
/// Returns an error if clipboard access fails.
#[napi(js_name = "copyToClipboard")]
pub fn copy_to_clipboard(text: String) -> task::Async<()> {
	task::blocking("clipboard.copy", (), move |_| -> Result<()> {
		let mut clipboard = Clipboard::new()
			.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
		clipboard
			.set_text(text)
			.map_err(|err| Error::from_reason(format!("Failed to copy to clipboard: {err}")))?;
		Ok(())
	})
}

/// Read an image from the system clipboard using native macOS pasteboard APIs.
///
/// Checks `public.png` first (for screenshots and Chrome), then falls back to
/// `public.tiff` (the default arboard format). Returns PNG bytes in both cases.
#[cfg(target_os = "macos")]
fn read_image_macos() -> Result<Option<Vec<u8>>> {
	use std::io::Cursor;

	use image::ImageFormat;
	use objc2_app_kit::NSPasteboard;
	use objc2_foundation::{NSArray, NSString};

	// SAFETY: NSPasteboard APIs require no special preconditions beyond running on
	// macOS. All pointer dereferences are guarded by Option checks above.
	unsafe {
		let pb = NSPasteboard::generalPasteboard();
		let png_type = NSString::from_str("public.png");
		let tiff_type = NSString::from_str("public.tiff");
		let types = NSArray::from_retained_slice(&[png_type.clone(), tiff_type]);

		let available = pb.availableTypeFromArray(&types);
		let Some(available) = available else {
			return Ok(None);
		};

		let data = pb.dataForType(&available);
		let Some(data) = data else {
			return Ok(None);
		};
		let bytes = data.to_vec();

		if *available == *png_type {
			Ok(Some(bytes))
		} else {
			// TIFF → PNG
			let img = image::load_from_memory_with_format(&bytes, ImageFormat::Tiff)
				.map_err(|e| Error::from_reason(format!("Failed to decode TIFF: {e}")))?;
			let mut out = Vec::new();
			img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
				.map_err(|e| Error::from_reason(format!("Failed to encode PNG: {e}")))?;
			Ok(Some(out))
		}
	}
}

/// Read an image from the system clipboard using arboard.
#[cfg(not(target_os = "macos"))]
fn read_image_arboard() -> Result<Option<Vec<u8>>> {
	let mut clipboard = Clipboard::new()
		.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
	match clipboard.get_image() {
		Ok(image) => Ok(Some(encode_png(image)?)),
		Err(ClipboardError::ContentNotAvailable) => Ok(None),
		Err(err) => Err(Error::from_reason(format!("Failed to read clipboard image: {err}"))),
	}
}

/// Read an image from the system clipboard.
///
/// Returns `Ok(None)` when no image data is available.
///
/// # Errors
/// Returns an error if clipboard access fails or image encoding fails.
#[napi(js_name = "readImageFromClipboard")]
pub fn read_image_from_clipboard() -> task::Async<Option<ClipboardImage>> {
	task::blocking("clipboard.read_image", (), move |_| -> Result<Option<ClipboardImage>> {
		#[cfg(target_os = "macos")]
		let png_bytes = read_image_macos()?;

		#[cfg(not(target_os = "macos"))]
		let png_bytes = read_image_arboard()?;

		Ok(png_bytes.map(|bytes| ClipboardImage {
			data:      Uint8Array::from(bytes),
			mime_type: "image/png".to_string(),
		}))
	})
}

/// Read plain text from the system clipboard.
///
/// Returns `Ok(None)` when no text data is available.
///
/// # Errors
/// Returns an error if clipboard access fails.
#[napi(js_name = "readTextFromClipboard")]
pub fn read_text_from_clipboard() -> task::Async<Option<String>> {
	task::blocking("clipboard.read_text", (), move |_| -> Result<Option<String>> {
		let mut clipboard = Clipboard::new()
			.map_err(|err| Error::from_reason(format!("Failed to access clipboard: {err}")))?;
		match clipboard.get_text() {
			Ok(text) => Ok(Some(text)),
			Err(ClipboardError::ContentNotAvailable) => Ok(None),
			Err(err) => Err(Error::from_reason(format!("Failed to read clipboard text: {err}"))),
		}
	})
}
