import geo from "./gulf.json";

/** The same Mercator projection the base geography was built with, so markers sit exactly on the coastlines. */
const rad = (d: number) => d * Math.PI / 180;
const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));
export const GEO = geo as { extent: { lonMin: number; lonMax: number; latMin: number; latMax: number }; width: number; height: number; radius: number; source: string; countries: { name: string; d: string }[] };
export const project = (lat: number, lon: number): [number, number] => [rad(lon - GEO.extent.lonMin) * GEO.radius, (my(GEO.extent.latMax) - my(lat)) * GEO.radius];
