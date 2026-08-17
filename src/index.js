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

plugin.configs.recommended = {
  plugins: { fold: plugin },
  rules: { 'fold/breaks': 'error' },
};

export default plugin;
