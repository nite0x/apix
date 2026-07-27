interface Props {
  flowName: string
  onCancel: () => void
  onConfirm: () => void
}

export function FlowDeleteDialog({ flowName, onCancel, onConfirm }: Props) {
  return (
    <div className="flow-dialog-backdrop" onClick={onCancel}>
      <div className="flow-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>Delete “{flowName}”?</h3>
        <p>Request history will be kept.</p>
        <div className="flow-dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  )
}
