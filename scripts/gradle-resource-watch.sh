    free -b 2>/dev/null | awk '
      NR == 2 { printf "memory_total_bytes=%s memory_used_bytes=%s memory_available_bytes=%s\n", $2, $3, $7 }
      NR == 3 { printf "swap_total_bytes=%s swap_used_bytes=%s swap_free_bytes=%s\n", $2, $3, $4 }
    ' || true
