if(CONFIG_ZDKM)
  # The ZMK position event listener must be linked before the built-in listeners.
  target_sources(app PRIVATE src/combo.c src/runtime.c src/serial.c src/keymap.c src/macro.c src/encoder.c)
  target_include_directories(app PRIVATE include)

  if(CONFIG_DT_HAS_ZMK_KEYMAP_SENSORS_ENABLED AND CONFIG_ZMK_BEHAVIOR_SENSOR_ROTATE_VAR)
    zephyr_link_libraries(-Wl,--wrap=zmk_behavior_sensor_rotate_common_process)
  endif()

  if(CONFIG_DT_HAS_ZMK_COMBOS_ENABLED)
    # Preserve the generated DT definitions and give their input processing to ZDKM.
    # Upstream adds this source after loading module CMake files.
    function(zdkm_use_dynamic_combo_listener)
      get_target_property(app_sources app SOURCES)
      set(upstream_combo "${APPLICATION_SOURCE_DIR}/src/combo.c")
      if("src/combo.c" IN_LIST app_sources)
        list(REMOVE_ITEM app_sources "src/combo.c")
      elseif("${upstream_combo}" IN_LIST app_sources)
        list(REMOVE_ITEM app_sources "${upstream_combo}")
      else()
        message(FATAL_ERROR "ZDKM cannot take over static combos on this ZMK version: app/src/combo.c was not found.")
      endif()
      set_property(TARGET app PROPERTY SOURCES "${app_sources}")
    endfunction()
    cmake_language(DEFER DIRECTORY "${APPLICATION_SOURCE_DIR}" CALL zdkm_use_dynamic_combo_listener)
  endif()
endif()
