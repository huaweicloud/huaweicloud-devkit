// Simulates a below-floor Node version in a spawned CLI child. The version
// properties are non-writable but configurable on real Node, so plain
// assignment silently does nothing; defineProperty is the only seam. An unset
// FAKE_NODE_VERSION leaves the child's real version untouched.
const fake = (process.env.FAKE_NODE_VERSION || '').trim();
if (fake) {
  const normalized = fake.replace(/^v/, '');
  Object.defineProperty(process.versions, 'node', { value: normalized });
  Object.defineProperty(process, 'version', { value: `v${normalized}` });
}
