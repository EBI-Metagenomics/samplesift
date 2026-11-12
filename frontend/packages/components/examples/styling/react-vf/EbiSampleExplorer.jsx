// Load from your React application's browser entry point.
// The host application supplies Visual Framework 2 CSS and IBM Plex Sans.
import '@samplesift/components';
import './samplesift-vf.css';

export function EbiSampleExplorer({
  apiUrl = '/samplesift',
  collection = 'occurrences',
  tileLayer = 'occurrences',
}) {
  return (
    <section className="ebi-samplesift">
      <h2 className="vf-text vf-text-heading--2">
        Explore biological samples
      </h2>
      <sample-sift
        api-url={apiUrl}
        collection={collection}
        tile-layer={tileLayer}
        page-size="25"
      />
    </section>
  );
}
