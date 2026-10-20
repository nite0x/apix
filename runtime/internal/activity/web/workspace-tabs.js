// Switch visibility only: drafts, results and in-flight work stay mounted.
export function setupWorkspaceTabs(id) {
  const tabs = [...document.getElementById(id).querySelectorAll('[role="tab"]')];
  function select(tab) {
    for (const control of tabs) {
      const selected = control === tab;
      control.setAttribute('aria-selected', String(selected));
      control.tabIndex = selected ? 0 : -1;
      document.getElementById(control.getAttribute('aria-controls')).hidden = !selected;
    }
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
        : tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
      select(target); target.focus();
    });
  }
  select(tabs.find(tab => tab.getAttribute('aria-selected') === 'true') || tabs[0]);
  return select;
}
