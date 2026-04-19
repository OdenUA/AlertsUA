import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSubscriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label_user?: string;

  @IsOptional()
  @IsBoolean()
  notify_on_start?: boolean;

  @IsOptional()
  @IsBoolean()
  notify_on_end?: boolean;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
