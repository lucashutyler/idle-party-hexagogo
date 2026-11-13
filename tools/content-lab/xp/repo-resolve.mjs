import { registerHooks } from 'node:module';

const NOT_FOUND = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'];
const isBare = specifier => !/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);

// A rework or plan naming live content lives outside the repository, where its bare imports find no node_modules.
// import.meta.resolve, not a retry with another parentURL: tsx loads a .ts outside any package as CommonJS, whose resolver ignores parentURL.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (!isBare(specifier) || !NOT_FOUND.includes(err?.code)) throw err;
      return { url: import.meta.resolve(specifier), shortCircuit: true };
    }
  },
});
