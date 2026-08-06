/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
// Deliberately not 'Hyundai'. The plugin this was forked from uses that name,
// and a platform name is what config.json refers to and half of the key
// Homebridge matches cached accessories against - so sharing one means
// Homebridge cannot tell which plugin a config block belongs to, and the two
// tangle over the same VIN-derived accessory UUID.
export const PLATFORM_NAME = 'HyundaiBlueLink3';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-bluelink-3-0';
