import { POST_TYPE } from './types';
import LinkedList from 'mobiledoc-kit/utils/linked-list';
import { forEach, compact } from 'mobiledoc-kit/utils/array-utils';
import Set from 'mobiledoc-kit/utils/set';
import mobiledocRenderers from 'mobiledoc-kit/renderers/mobiledoc';
import Range from 'mobiledoc-kit/utils/cursor/range';
import Position from 'mobiledoc-kit/utils/cursor/position';
import deprecate from 'mobiledoc-kit/utils/deprecate';

/**
 * The Post is an in-memory representation of an editor's document.
 * An editor always has a single post. The post is organized into a list of
 * sections. Each section may be markerable (contains "markers", aka editable
 * text) or non-markerable (e.g., a card).
 * When persisting a post, it must first be serialized (loss-lessly) into
 * mobiledoc using {@link Editor#serialize}.
 */
class Post {
  /**
   * @private
   */
  constructor() {
    this.type = POST_TYPE;
    this.sections = new LinkedList({
      adoptItem: s => s.post = s.parent = this,
      freeItem: s => s.post = s.parent = null
    });
  }

  headPosition() {
    if (this.isBlank) {
      return Position.blankPosition();
    } else {
      return this.sections.head.headPosition();
    }
  }

  tailPosition() {
    if (this.isBlank) {
      return Position.blankPosition();
    } else {
      return this.sections.tail.tailPosition();
    }
  }

  get isBlank() {
    return this.sections.isEmpty;
  }

  /**
   * @param {Range} range
   * @return {Array} markers that are completely contained by the range
   */
  markersContainedByRange(range) {
    const markers = [];

    this.walkMarkerableSections(range, section => {
      section._markersInRange(
        range.trimTo(section),
        (m, {isContained}) => { if (isContained) { markers.push(m); } }
      );
    });

    return markers;
  }

  cutMarkers(markers) {
    let firstSection = markers.length && markers[0].section,
        lastSection  = markers.length && markers[markers.length - 1].section;

    let currentSection = firstSection;
    let removedSections = [],
        changedSections = compact([firstSection, lastSection]);

    if (markers.length !== 0) {
      markers.forEach(marker => {
        if (marker.section !== currentSection) { // this marker is in a section we haven't seen yet
          if (marker.section !== firstSection &&
              marker.section !== lastSection) {
            // section is wholly contained by markers, and can be removed
            removedSections.push(marker.section);
          }
        }

        currentSection = marker.section;
        currentSection.markers.remove(marker);
      });

      if (firstSection !== lastSection) {
        firstSection.join(lastSection);
        removedSections.push(lastSection);
      }
    }

    return {changedSections, removedSections};
  }

  /**
   * Invoke `callbackFn` for all markers between the headMarker and tailMarker (inclusive),
   * across sections
   * @private
   */
  markersFrom(headMarker, tailMarker, callbackFn) {
    let currentMarker = headMarker;
    while (currentMarker) {
      callbackFn(currentMarker);

      if (currentMarker === tailMarker) {
        currentMarker = null;
      } else if (currentMarker.next) {
        currentMarker = currentMarker.next;
      } else {
        let nextSection = this._nextMarkerableSection(currentMarker.section);
        // FIXME: This will fail across cards
        currentMarker = nextSection && nextSection.markers.head;
      }
    }
  }

  markupsInRange(range) {
    const markups = new Set();

    if (range.isCollapsed) {
      let pos = range.head;
      if (pos.isMarkerable) {
        let [back, forward] = [pos.markerIn(-1), pos.markerIn(1)];
        if (back && forward && back === forward) {
          back.markups.forEach(m => markups.add(m));
        } else {
          (back && back.markups || []).forEach(m => {
            if (m.isForwardInclusive()) {
              markups.add(m);
            }
          });
          (forward && forward.markups || []).forEach(m => {
            if (m.isBackwardInclusive()) {
              markups.add(m);
            }
          });
        }
      }
    } else {
      this.walkMarkerableSections(range, (section) => {
        forEach(
          section.markupsInRange(range.trimTo(section)),
          m => markups.add(m)
        );
      });
    }

    return markups.toArray();
  }

  walkAllLeafSections(callback) {
    let range = new Range(this.sections.head.headPosition(),
                          this.sections.tail.tailPosition());
    return this.walkLeafSections(range, callback);
  }

  walkLeafSections(range, callback) {
    const { head, tail } = range;

    let index = 0;
    let nextSection, shouldStop;
    let currentSection = head.section;

    while (currentSection) {
      nextSection = this._nextLeafSection(currentSection);
      shouldStop = currentSection === tail.section;

      callback(currentSection, index);
      index++;

      if (shouldStop) {
        break;
      } else {
        currentSection = nextSection;
      }
    }
  }

  walkMarkerableSections(range, callback) {
    this.walkLeafSections(range, section => {
      if (section.isMarkerable) {
        callback(section);
      }
    });
  }

  /**
   * @param {Range} range
   * @return {Section[]} All top-level sections (direct children of `post`) wholly
   *         contained by {range}. Sections that are partially contained by the range
   *         are not returned.
   * @private
   */
  sectionsContainedBy(range) {
    const {head, tail} = range;
    let containedSections = [];

    const findParent = (child, conditionFn) => {
      while (child) {
        if (conditionFn(child)) { return child; }
        child = child.parent;
      }
    };

    const headTopLevelSection = findParent(head.section, s => s.parent === s.post);
    const tailTopLevelSection = findParent(tail.section, s => s.parent === s.post);

    if (headTopLevelSection === tailTopLevelSection) {
      return containedSections;
    }

    let currentSection = headTopLevelSection.next;
    while (currentSection && currentSection !== tailTopLevelSection) {
      containedSections.push(currentSection);
      currentSection = currentSection.next;
    }

    return containedSections;
  }

  _nextMarkerableSection(section) {
    let nextSection = this._nextLeafSection(section);

    while (nextSection && !nextSection.isMarkerable) {
      nextSection = this._nextLeafSection(nextSection);
    }

    return nextSection;
  }

  // return the next section that has markers after this one,
  // possibly skipping non-markerable sections
  _nextLeafSection(section) {
    if (!section) { return null; }
    const hasChildren  = s => !!s.items;
    const firstChild   = s => s.items.head;

    // FIXME this can be refactored to use `isLeafSection`
    const next = section.next;
    if (next) {
      if (hasChildren(next)) { // e.g. a ListSection
        return firstChild(next);
      } else {
        return next;
      }
    } else if (section.isNested) {
      // if there is no section after this, but this section is a child
      // (e.g. a ListItem inside a ListSection), check for a markerable
      // section after its parent
      return this._nextLeafSection(section.parent);
    }
  }

  /**
   * @deprecated since 0.9.1
   */
  cloneRange(range) {
    deprecate('post#cloneRange is deprecated. See post#trimTo(range) and editor#serializePost');
    return mobiledocRenderers.render(this.trimTo(range));
  }

  /**
   * @param {Range} range
   * @return {Post} A new post, constrained to {range}
   */
  trimTo(range) {
    const post = this.builder.createPost();
    const { builder } = this;

    let sectionParent = post,
        listParent = null;
    this.walkLeafSections(range, section => {
      let newSection;
      if (section.isMarkerable) {
        if (section.isListItem) {
          if (listParent) {
            sectionParent = null;
          } else {
            listParent = builder.createListSection(section.parent.tagName);
            post.sections.append(listParent);
            sectionParent = null;
          }
          newSection = builder.createListItem();
          listParent.items.append(newSection);
        } else {
          listParent = null;
          sectionParent = post;
          newSection = builder.createMarkupSection(section.tagName);
        }

        let currentRange = range.trimTo(section);
        forEach(
          section.markersFor(currentRange.headSectionOffset, currentRange.tailSectionOffset),
          m => newSection.markers.append(m)
        );
      } else {
        newSection = section.clone();
      }
      if (sectionParent) {
        sectionParent.sections.append(newSection);
      }
    });
    return post;
  }
}

export default Post;
