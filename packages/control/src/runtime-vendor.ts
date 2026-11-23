/** Only runtimes that run a single vendor's models; multi-model clients stay unknown. */
export const RUNTIME_VENDOR: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
};

export function runtimeVendor(name: string): string {
  return Object.hasOwn(RUNTIME_VENDOR, name) ? RUNTIME_VENDOR[name]! : 'unknown';
}

const INDEPENDENCE = ['other_vendor', 'other_runtime', 'same_runtime'] as const;
type Independence = (typeof INDEPENDENCE)[number];

/** How far a reviewer runtime stands from every writer runtime. */
export function runtimeIndependence(writers: string[], name: string): Independence {
  const vendor = runtimeVendor(name);
  // A writer of unknown vendor may run any vendor's model, so no runtime counts as another vendor.
  if (
    writers.length > 0 &&
    vendor !== 'unknown' &&
    writers.map(runtimeVendor).every((writer) => writer !== 'unknown' && writer !== vendor)
  )
    return 'other_vendor';
  return writers.includes(name) ? 'same_runtime' : 'other_runtime';
}
