import { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { DeliveryRound, IceTypeOption, RoundMemberOption } from '../types/app';

export function useReferenceData(canCreateRound: boolean) {
  const [rounds, setRounds] = useState<DeliveryRound[]>([]);
  const [iceTypes, setIceTypes] = useState<IceTypeOption[]>([]);
  const [memberOptions, setMemberOptions] = useState<RoundMemberOption[]>([]);
  const [selectedRoundId, setSelectedRoundId] = useState<string>('');
  const [loadingRounds, setLoadingRounds] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const loadReferenceData = useCallback(async () => {
    if (!supabase) {
      return;
    }

    setLoadingRounds(true);
    setWorkspaceError(null);

    const [roundsResponse, iceTypesResponse, membersResponse] = await Promise.all([
      supabase
        .from('delivery_rounds')
        .select('id, service_date, name, status, opened_at')
        .order('service_date', { ascending: false })
        .order('opened_at', { ascending: false }),
      supabase
        .from('ice_types')
        .select('id, code, name, unit')
        .eq('is_active', true)
        .order('code'),
      canCreateRound
        ? supabase.rpc('get_assignable_round_members')
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (roundsResponse.error) {
      setWorkspaceError(roundsResponse.error.message);
    } else {
      const nextRounds = (roundsResponse.data ?? []) as DeliveryRound[];
      setRounds(nextRounds);
      setSelectedRoundId((current) => (
        nextRounds.some((round) => round.id === current) ? current : nextRounds[0]?.id ?? ''
      ));
    }

    if (iceTypesResponse.error) {
      setWorkspaceError(iceTypesResponse.error.message);
    } else {
      setIceTypes((iceTypesResponse.data ?? []) as IceTypeOption[]);
    }

    if (membersResponse.error) {
      setWorkspaceError(membersResponse.error.message);
    } else {
      setMemberOptions((membersResponse.data ?? []) as RoundMemberOption[]);
    }

    setLoadingRounds(false);
  }, [canCreateRound]);

  return {
    rounds,
    iceTypes,
    memberOptions,
    selectedRoundId,
    setSelectedRoundId,
    loadingRounds,
    workspaceError,
    loadReferenceData,
  };
}
