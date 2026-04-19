export class OblastAlertHistoryItem {
  region_title_uk!: string;
  raion_title_uk!: string | null;
  started_at!: string; // ISO datetime
  ended_at!: string | null; // ISO datetime or null if ongoing
}

export class OblastAlertHistory {
  active: OblastAlertHistoryItem[] = [];
  today: OblastAlertHistoryItem[] = [];
  yesterday: OblastAlertHistoryItem[] = [];
}

export class ResolvedRegion {
  leaf_uid!: number;
  leaf_type!: string;
  hromada_title_uk!: string;
  hromada_status!: string;
  raion_uid!: number | null;
  raion_title_uk!: string | null;
  raion_status!: string | null;
  oblast_uid!: number | null;
  oblast_title_uk!: string | null;
  oblast_status!: string | null;
  active_from!: string | null;
  oblast_history!: OblastAlertHistory; // EXPLICITLY INCLUDED
  leaf_title_uk!: string;
  current_status!: string;
  current_status_label_uk!: string;
}

export class ResolvePointResponseDto {
  address_uk!: string;
  resolved_region!: ResolvedRegion;
  latitude!: number;
  longitude!: number;
}
