import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateInstallationDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  app_version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  app_build?: string;

  @IsOptional()
  @IsBoolean()
  notifications_enabled?: boolean;
}
