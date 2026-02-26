import {
	type Component,
	getImageDimensions,
	Image,
	ImageProtocol,
	imageFallback,
	Spacer,
	TERMINAL,
} from "@nghyane/arcane-tui";
import { convertToPng } from "../../utils/image-convert";

type ImageBlock = { data?: string; mimeType?: string };

/**
 * Manages image rendering for tool results.
 * Handles Kitty PNG conversion, spacers, and fallback text.
 */
export class ToolImageDisplay {
	#images: Image[] = [];
	#spacers: Spacer[] = [];
	#convertedImages = new Map<number, { data: string; mimeType: string }>();
	#parent: { addChild(c: Component): void; removeChild(c: Component): void };
	#onUpdate: () => void;

	constructor(parent: { addChild(c: Component): void; removeChild(c: Component): void }, onUpdate: () => void) {
		this.#parent = parent;
		this.#onUpdate = onUpdate;
	}

	/**
	 * Trigger async PNG conversion for Kitty protocol.
	 * Call when result is first received or updated.
	 */
	convertForKitty(imageBlocks: ImageBlock[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.#convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType)
				.then(converted => {
					if (converted) {
						this.#convertedImages.set(index, converted);
						this.#onUpdate();
					}
				})
				.catch(() => {});
		}
	}

	/**
	 * Update displayed images. Removes old components, adds new ones.
	 */
	update(imageBlocks: ImageBlock[], showImages: boolean, themeFg: (s: string) => string): void {
		// Remove old
		for (const img of this.#images) this.#parent.removeChild(img);
		for (const spacer of this.#spacers) this.#parent.removeChild(spacer);
		this.#images = [];
		this.#spacers = [];

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!TERMINAL.imageProtocol || !showImages || !img.data || !img.mimeType) continue;

			const converted = this.#convertedImages.get(i);
			const imageData = converted?.data ?? img.data;
			const imageMimeType = converted?.mimeType ?? img.mimeType;

			// Kitty requires PNG — skip unconverted non-PNG
			if (TERMINAL.imageProtocol === ImageProtocol.Kitty && imageMimeType !== "image/png") {
				continue;
			}

			const spacer = new Spacer(1);
			this.#parent.addChild(spacer);
			this.#spacers.push(spacer);

			const imageComponent = new Image(
				imageData,
				imageMimeType,
				{
					fallbackColor: (s: string) => themeFg(s),
				},
				{ maxWidthCells: 60 },
			);
			this.#images.push(imageComponent);
			this.#parent.addChild(imageComponent);
		}
	}

	/**
	 * Get text fallback for images when terminal doesn't support image display.
	 */
	static fallbackText(imageBlocks: ImageBlock[]): string {
		return imageBlocks
			.filter((img): img is ImageBlock & { mimeType: string } => !!img.mimeType)
			.map(img => {
				const dims = img.data ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(img.mimeType, dims);
			})
			.join("\n");
	}
}
