# ADR 0019: Governed settings

Status: accepted. Implements resolutions R2 to R4 (round 3).

- Tiger Capital AI owns the numbers that were placeholders: signal thresholds, scenario default assumptions and ranges, and Hormuz exposure and bypass capacity. They are institution settings, not code.
- A settings version is drafted by one administrator and activated by a different one, with a reason of at least ten characters. Versions never change and are never deleted; a newer activation retires the older one. Policy rules and authority already work the same way and are linked from the same screen.
- Signal thresholds change what the attention queue raises. The sector view and every case opened from a signal record the settings version in force.
- Scenario defaults replace a template's default value, range and basis. A value that claims a source must cite an evidence record that exists. The parameter's own note says it came from an institution setting and which version. A run's explicit overrides still win, and each run records the version it used and keeps its parameters, so replay is unaffected by later changes.
- Hormuz exposure is written into the graph on activation, retiring the old links, with the link class the basis states. A sourced value cannot be saved without evidence, and a country that is not in the graph is refused.
- The values Tiger sets are not validated for truth by the system. The system guarantees who set them, when, why, under which version, and that every output says so.
