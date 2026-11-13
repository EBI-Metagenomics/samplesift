async function render({ model, el }, loadComponent) {
  const url = model.get("component_url");
  if (url) await import(/* @vite-ignore */ url);
  else await loadComponent();
  const component = document.createElement("sample-sift");
  let ready = false;
  let reflecting = false;
  let mounted = false;
  const publish = (values) => {
    reflecting = true;
    try {
      model.set(structuredClone(values));
      model.save_changes();
    } finally { reflecting = false; }
  };
  const applyState = () => {
    if (reflecting || !ready) return;
    try {
      component.setCollectionState(structuredClone(model.get("query_state")));
      component.collectionPaused = false;
      publish({ query_error: "" });
    } catch (error) {
      component.collectionPaused = true;
      publish({ query_error: error.message, page: {} });
    }
  };
  const properties = {
    demo: "demo", api_url: "apiUrl", collection: "collection", tile_layer: "tileLayer",
  };
  const listeners = Object.entries(properties).map(([trait, property]) => {
    const update = () => {
      component[property] = model.get(trait);
      if (mounted && ["api_url", "collection", "tile_layer"].includes(trait)) {
        ready = false;
        component.collectionPaused = Boolean(model.get("collection"));
        publish({ page: {}, query_error: "" });
      }
    };
    update();
    model.on(`change:${trait}`, update);
    return [trait, update];
  });
  component.collectionPaused = Boolean(model.get("collection"));
  model.on("change:query_state", applyState);
  listeners.push(["query_state", applyState]);
  const events = {
    collectionready: () => { ready = true; applyState(); },
    collectionstatechange: (event) => publish({ query_state: event.detail.state }),
    collectionresultschange: (event) => {
      if (!ready || component.collectionPaused
        || JSON.stringify(event.detail.state) !== JSON.stringify(model.get("query_state"))) return;
      publish({
        page: { ...event.detail, api_url: component.apiUrl, collection: component.collection },
        query_state: event.detail.state, query_error: "",
      });
    },
    collectiontileschange: (event) => publish({ tile_status: event.detail }),
    searcherror: (event) => publish({ query_error: event.detail.message }),
  };
  for (const [name, listener] of Object.entries(events)) component.addEventListener(name, listener);
  mounted = true;
  el.append(component);
  return () => {
    for (const [trait, update] of listeners) model.off(`change:${trait}`, update);
    for (const [name, listener] of Object.entries(events)) component.removeEventListener(name, listener);
    component.remove();
  };
}

export default { render };
