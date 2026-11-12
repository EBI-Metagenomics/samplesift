// Import this component from the browser entry point of your React app.
import '@microbiome-informatics/samplesift';
import '../samplesift-theme.css';

export function SampleExplorer({
  apiUrl = '/samplesift',
  collection = 'occurrences',
  tileLayer = 'occurrences',
  layout = 'compact',
  showTable = false,
}) {
  return (
    <div className="sample-theme">
      <sample-sift
        api-url={apiUrl}
        collection={collection}
        tile-layer={tileLayer}
        layout={layout}
        show-table={showTable ? '' : undefined}
        page-size="25"
      />
    </div>
  );
}
