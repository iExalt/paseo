if .version != 4 or (.derivations | type) != "object" or (.derivations | length) == 0 then
  error("Expected Nix v4 derivation envelope")
else
  .derivations | map_values(
    if .version != 4 or (.env | type) != "object" then
      error("Expected Nix v4 derivation environment")
    else
      .env | with_entries(select(.key | test("(NIX|MAKE|JOBS|CORES|FLAGS)")))
    end
  )
end
