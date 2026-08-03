import { REGION } from 'bluelinky/dist/constants';
import {
  Brand,
  VehicleStartOptions,
} from 'bluelinky/dist/interfaces/common.interfaces';
import { PlatformConfig } from 'homebridge';

interface AuthConfig {
  username: string;
  password: string;
  pin: string;
  region: REGION;
  brand: Brand;
}
interface VehicleConfig {
  vin: string;
  maxRange?: number;
}
export interface HyundaiConfig extends PlatformConfig {
  credentials: AuthConfig;
  vehicles: VehicleConfig[];
  remoteStart: VehicleStartOptions;
  // Minutes between reads of Hyundai's cached status. These do not contact
  // the vehicle, so they cost it nothing.
  statusInterval?: number;
  // Minutes between forced refreshes, which wake the vehicle over cellular.
  // 0 disables them.
  forceRefreshInterval?: number;
}
