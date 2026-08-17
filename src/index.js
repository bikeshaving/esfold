import breaks from './rules/breaks.js';

const plugin = {
  meta: {
    name: 'eslint-plugin-fold',
    version: '0.1.0',
  },
  rules: {
    breaks,
  },
  configs: {},
};

// Self-referential, so the config object has to be attached after the
// plugin exists. `name` shows up in flat-config error messages and
// `--inspect-config`.
plugin.configs.recommended = {
  name: 'fold/recommended',
  plugins: { fold: plugin },
  rules: { 'fold/breaks': 'error' },
};

export default plugin;
