// Import this component from the browser entry point of your React app.
import '@samplesift/components';
import '../samplesift-theme.css';

export function SampleExplorer({
  apiUrl = '/samplesift',
  collection = 'occurrences',
  tileLayer = 'occurrences',
}) {
  return (
    <div className="sample-theme">
      <sample-sift
        api-url={apiUrl}
        collection={collection}
        tile-layer={tileLayer}
        page-size="25"
      />
    </div>
  );
}
