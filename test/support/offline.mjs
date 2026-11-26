// Loaded before every test file (package.json `test`): no test reaches the network. A test that needs an HTTP answer
// passes its own fetch (ctx.deps.fetch). On a machine that runs EasyCLIProxyAPI, `orq wait` would otherwise ask it.
globalThis.fetch = async (url) => {
  throw new Error(`network disabled in tests: ${String(url).split('?')[0]}`);
};
