import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export function useActivity() {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['activity'],
    queryFn: async ({ signal }) => {
      const previous = client.getQueryData<any>(['activity']);
      const query = new URLSearchParams();
      if (previous) {
        query.set('event_after', String(previous.event_cursor));
        query.set('service_after', String(previous.service_cursor));
      }
      const data = await api<any>(`/activity?${query}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      return {
        ...data,
        events: [
          ...(data.reset_events ? [] : (previous?.events ?? [])),
          ...(data.events ?? []),
        ].slice(-1000),
        service_logs: [
          ...(data.reset_services ? [] : (previous?.service_logs ?? [])),
          ...(data.service_logs ?? []),
        ].slice(-1000),
        total_logs:
          (previous?.total_logs ?? 0) +
          (data.events?.length ?? 0) +
          (data.service_logs?.length ?? 0),
      };
    },
    refetchInterval: (query) => (query.state.data?.more ? 100 : 2000),
    retry: false,
  });
}
