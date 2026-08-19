/**
 * Compatibility entrypoint for the extracted package contract.
 *
 * The app keeps this path temporarily so host adapters and characterization
 * tests do not need a broad import rewrite. Runtime and type authority lives
 * in @yohawing/timeline-editor/core.
 */
export * from "@yohawing/timeline-editor/core";
