import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared';

const EditorState = createContext<(state: { dirty: boolean; pending: boolean }) => void>(() => {});
export function useEditorState(dirty: boolean, pending: boolean) {
  const report = useContext(EditorState);
  useEffect(() => {
    report({ dirty, pending });
  }, [dirty, pending, report]);
}
export function EditorDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: (close: () => void, complete: () => void) => ReactNode;
}) {
  const [state, setState] = useState({ dirty: false, pending: false });
  const [confirm, setConfirm] = useState(false);
  function complete() {
    setConfirm(false);
    setState({ dirty: false, pending: false });
    onOpenChange(false);
  }
  function close() {
    if (state.pending) return;
    if (state.dirty) setConfirm(true);
    else complete();
  }
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogContent
          className="max-w-3xl max-h-[90vh] overflow-y-auto"
          onEscapeKeyDown={(event) => {
            if (state.pending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (state.pending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <EditorState.Provider value={setState}>
            {open && children(close, complete)}
          </EditorState.Provider>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="放弃未保存的修改？"
        description="关闭编辑器会丢失当前输入。"
        onConfirm={complete}
      />
    </>
  );
}
