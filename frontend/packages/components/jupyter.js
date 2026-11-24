import widget from '../../../src/samplesift/jupyter/static/widget.js';

export default {
  render: context => widget.render(context, () => import('./src/index.ts')),
};
