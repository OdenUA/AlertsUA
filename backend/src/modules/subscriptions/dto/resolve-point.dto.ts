import { IsLatitude, IsLongitude } from 'class-validator';

export class ResolvePointDto {
  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;
}
