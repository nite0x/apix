import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

it('passes the document CSP nonce to Radix select viewport styles', async () => {
  const meta = document.createElement('meta');
  meta.name = 'apix-style-nonce';
  meta.content = 'test-document-nonce';
  document.head.append(meta);
  try {
    render(
      <Select defaultValue="one">
        <SelectTrigger aria-label="测试选择">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">第一项</SelectItem>
        </SelectContent>
      </Select>,
    );
    await userEvent.click(screen.getByRole('combobox', { name: '测试选择' }));
    const style = [...document.querySelectorAll('style')].find((item) =>
      item.textContent?.includes('data-radix-select-viewport'),
    );
    expect(style).toHaveAttribute('nonce', 'test-document-nonce');
  } finally {
    meta.remove();
  }
});
