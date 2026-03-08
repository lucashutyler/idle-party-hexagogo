<template>
  <div class="admin-layout">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1>World Manager</h1>
        <span class="sidebar-subtitle">Idle Party RPG</span>
      </div>
      <nav class="sidebar-nav">
        <router-link to="/" class="nav-item" exact-active-class="active">
          <span class="nav-icon">&#9632;</span>
          Dashboard
        </router-link>
        <router-link to="/monsters" class="nav-item" active-class="active">
          <span class="nav-icon">&#9760;</span>
          Monsters
        </router-link>
        <router-link to="/items" class="nav-item" active-class="active">
          <span class="nav-icon">&#9874;</span>
          Items
        </router-link>
        <router-link to="/zones" class="nav-item" active-class="active">
          <span class="nav-icon">&#9672;</span>
          Zones
        </router-link>
        <router-link to="/tile-types" class="nav-item" active-class="active">
          <span class="nav-icon">&#11042;</span>
          Tile Types
        </router-link>
        <router-link to="/maps" class="nav-item" active-class="active">
          <span class="nav-icon">&#9635;</span>
          Maps
        </router-link>
        <router-link to="/players" class="nav-item" active-class="active">
          <span class="nav-icon">&#9823;</span>
          Players
        </router-link>
      </nav>
    </aside>
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
</script>
