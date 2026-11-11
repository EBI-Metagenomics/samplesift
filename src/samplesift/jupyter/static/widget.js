async function render({ model, el }) {
  await import(/* @vite-ignore */ model.get("component_url"));
  const component = document.createElement("sample-sift");
  const properties = {
    demo: "demo",
    api_url: "apiUrl",
    collection: "collection",
    tile_layer: "tileLayer",
  };
  const listeners = Object.entries(properties).map(([trait, property]) => {
    const update = () => { component[property] = model.get(trait); };
    update();
    model.on(`change:${trait}`, update);
    return [trait, update];
  });
  el.append(component);
  return () => {
    for (const [trait, update] of listeners) model.off(`change:${trait}`, update);
    component.remove();
  };
}

export default { render };
