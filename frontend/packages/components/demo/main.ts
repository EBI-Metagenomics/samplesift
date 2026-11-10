import '../src/index';
import { taxonomyOptions } from './taxonomy-options';
for (const explorer of document.querySelectorAll('sample-sift')) {
  explorer.taxonomyOptions = taxonomyOptions;
}
