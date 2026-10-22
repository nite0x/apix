import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { DirtyProvider, useDirty } from './use-dirty';

function Draft({ name }: {name: string}) { useDirty(true); return <p>{name}</p>; }
it('aggregates dirty editors into one route guard and respects cancelled navigation', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const router = createMemoryRouter([{ element: <DirtyProvider><Outlet /></DirtyProvider>, children: [{ path: '/', element: <><Draft name="editor one" /><Draft name="editor two" /><Link to="/next">离开</Link></> }, { path: '/next', element: <h1>next page</h1> }] }]);
  render(<RouterProvider router={router} />);
  await userEvent.click(screen.getByText('离开'));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(screen.getByText('editor one')).toBeInTheDocument();
  confirm.mockReturnValue(true);
  await userEvent.click(screen.getByText('离开'));
  expect(await screen.findByText('next page')).toBeInTheDocument();
});
