import { createRouter, createWebHistory } from 'vue-router';
import DashboardPage from './pages/DashboardPage.vue';
import MonstersPage from './pages/MonstersPage.vue';
import ItemsPage from './pages/ItemsPage.vue';
import ZonesPage from './pages/ZonesPage.vue';
import TileTypesPage from './pages/TileTypesPage.vue';
import MapsPage from './pages/MapsPage.vue';
import MapEditorPage from './pages/MapEditorPage.vue';
import PlayersPage from './pages/PlayersPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: DashboardPage },
    { path: '/monsters', component: MonstersPage },
    { path: '/items', component: ItemsPage },
    { path: '/zones', component: ZonesPage },
    { path: '/tile-types', component: TileTypesPage },
    { path: '/maps', component: MapsPage },
    { path: '/maps/:id', component: MapEditorPage },
    { path: '/players', component: PlayersPage },
  ],
});
