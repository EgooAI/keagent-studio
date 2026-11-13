package main

// Task snapshots and media remain available after a listing is removed.
func deleteProperty(w object, propertyID string) error {
	if find(w["properties"], propertyID) == nil {
		return fail(404, "房源不存在或已删除")
	}
	properties := []any{}
	for _, value := range rows(w["properties"]) {
		if str(obj(value)["id"]) != propertyID {
			properties = append(properties, value)
		}
	}
	w["properties"] = properties
	for _, config := range []object{obj(w["draft"]), obj(obj(w["profile"])["defaults"])} {
		if config == nil {
			continue
		}
		ids := []any{}
		for _, value := range rows(config["propertyIds"]) {
			if str(value) != propertyID {
				ids = append(ids, value)
			}
		}
		config["propertyIds"] = ids
	}
	return nil
}
