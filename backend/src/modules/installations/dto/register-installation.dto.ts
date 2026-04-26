import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class RegisterInstallationDto {
  @IsString()
  platform!: string;

  @IsString()
  locale!: string;

  @IsString()
  @MaxLength(32)
  app_version!: string;

  @IsString()
  @MaxLength(32)
  app_build!: string;

  @IsString()
  @MaxLength(128)
  device_model!: string;

  @IsString()
  fcm_token!: string;

  @IsOptional()
  @IsBoolean()
  notifications_enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  android_id?: string;
}
