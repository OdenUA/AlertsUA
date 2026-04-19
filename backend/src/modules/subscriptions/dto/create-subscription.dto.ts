import { IsBoolean, IsLatitude, IsLongitude, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSubscriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label_user?: string;

  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;

  @IsBoolean()
  notify_on_start!: boolean;

  @IsBoolean()
  notify_on_end!: boolean;
}
